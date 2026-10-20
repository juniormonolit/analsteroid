import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { ropScope, type RopScope } from '@/features/tv/engine/access';
import { scopeManagers } from '@/features/rop-kanban/engine/kanban';
import { fetchManagerCustomers } from '@/features/customers/engine/customers';
import { buildRepeatBoard, type BoardSort, type TaskBucket } from '@/features/repeat-kanban/engine/board';

const TASK_BUCKETS = ['none', 'unread', 'work', 'overdue', 'control', 'done'] as const;
const SORTS = ['default', 'ltv', 'potential', 'fresh', 'task'] as const;
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { analyticsDb } from '@/lib/db/clients';
import { COLUMNS, type ColumnKey, type ReviewDecision } from '@/features/repeat-kanban/engine/config';
import { createRepeatTask, DealCreateError, ropOfManager } from '@/features/repeat-kanban/engine/createDeal';
import { decideReview, hideFromPool, markBrakNow, restoreFromBrak, ReviewError, unhide } from '@/features/repeat-kanban/engine/reviews';

// Канбан повторных продаж (решения владельца 20.10, REPEAT_KANBAN_SPEC.md).
// Гейт — section.repeat_kanban (ролям продаж, миграция 230). Зона — ropScope() сессии,
// как у «Канбана РОПа»: РОП — свои отделы с поддеревом, менеджер — только себя.
// Действия РОПа (задача, сделка, разбор) — только над менеджерами своей зоны и только
// по заказчикам этого менеджера. Задачи — в Битриксе (проект 118), закрывает их постановщик.
export const dynamic = 'force-dynamic';

const COLUMN_KEYS = new Set<string>(COLUMNS.map(c => c.key));

/** Менеджеры выбранных отделов (вместе с потомками) — резолвер тот же, что у «Моей
 *  команды» (lib/org/teamRoster). */
async function managersOfDepartments(deptIds: string[]): Promise<{ id: string; name: string }[]> {
  // DepartmentPicker кладёт в адрес ЧИСЛОВЫЕ id отделов Битрикса (bitrix_department_id,
  // `?dept=24,625,34`), а резолвер ждёт UUID sa.departments. Живой баг 20.10: Москва →
  // пусто, потому что проверял руками UUID из дерева, а не то, что шлёт пикер. Берём оба.
  const numeric = deptIds.filter(x => /^\d+$/.test(x));
  const uuids = deptIds.filter(x => !/^\d+$/.test(x));
  if (numeric.length) {
    const r = await analyticsDb().query<{ id: string }>(
      `SELECT id::text AS id FROM sa.departments WHERE bitrix_department_id::text = ANY($1::text[])`, [numeric],
    );
    uuids.push(...r.rows.map(x => x.id));
  }
  const rows = await resolveManagersForDepartments(uuids);
  const seen = new Map<string, string>();
  for (const m of rows) if (/^\d+$/.test(String(m.managerId))) seen.set(String(m.managerId), m.name || m.login || String(m.managerId));
  return [...seen].map(([id, name]) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name, 'ru'));
}

async function context(session: SessionUser) {
  const scope: RopScope = await ropScope(session);
  const managers = await scopeManagers(scope);
  // РОП = в зоне есть кто-то кроме него самого.
  const canManage = !scope.selfOnly && managers.some(m => m.id !== session.bitrixUserId);
  return { scope, managers, canManage };
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  // ?managers=id,id — отмеченные галочками (старый ?manager=id — тоже принимаем: ссылки).
  const rawMgrs = [...(sp.get('managers') ?? '').split(','), sp.get('manager') ?? ''].filter(x => /^\d{1,10}$/.test(x));
  const type = sp.get('type');
  const limits: Partial<Record<ColumnKey, number>> = {};
  for (const [k, v] of sp) {
    if (k.startsWith('n_') && COLUMN_KEYS.has(k.slice(2)) && /^\d{1,4}$/.test(v)) limits[k.slice(2) as ColumnKey] = Number(v);
  }
  try {
    const ctx = await context(session);
    const deptIds = (sp.get('dept') ?? '').split(',').filter(x => /^[0-9a-f-]{1,40}$/i.test(x)).slice(0, 300);
    // Отделы сужают зону, но не расширяют: чужой отдел в параметре даст пустой список.
    // Полный доступ (админ): менеджеры отделов берутся напрямую из оргструктуры. Раньше
    // они пересекались со списком дерева «Телевизоров» (scopeManagers), где нет, например,
    // стажировки и части филиалов — у админа выбор отделов давал пустую доску (20.10).
    // РОПу — пересечение с его зоной: отдел вне зоны даст пусто.
    const inDepts = deptIds.length ? await managersOfDepartments(deptIds) : null;
    const zone = new Set(ctx.managers.map(m => m.id));
    // Зона РОПа — и менеджеры его отделов по оргструктуре (список «Телевизоров» неполон).
    if (inDepts && !ctx.scope.full && ctx.scope.allowedDeptIds?.size) {
      for (const m of await managersOfDepartments([...ctx.scope.allowedDeptIds])) zone.add(m.id);
    }
    const managers = !inDepts ? ctx.managers : ctx.scope.full ? inDepts : inDepts.filter(m => zone.has(m.id));
    const canManage = ctx.canManage;
    // ?meta=1 — только список менеджеров (для пикера: виден сразу, не ждёт сборки доски).
    if (sp.get('meta') === '1') return NextResponse.json({ managers }, { headers: { 'Cache-Control': 'no-store' } });
    const inList = new Set(managers.map(m => m.id));
    const selected = rawMgrs.filter(id => inList.has(id));
    if (inDepts && managers.length === 0) {
      const board = await buildRepeatBoard({ managers: [], selectedManagers: [], typeFilter: null, canManage });
      return NextResponse.json({ ...board, notice: 'В выбранных отделах нет менеджеров из вашей зоны.' }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const board = await buildRepeatBoard({
      managers, selectedManagers: selected, typeFilter: type && /^[a-z_]{2,30}$/.test(type) ? type : null, limits, canManage,
      // ?pg=Газобетон|Кровля — группы через «|» (в названиях групп бывают запятые).
      poolGroups: (sp.get('pg') ?? '').split('|').map(x => x.trim()).filter(x => x.length > 0 && x.length < 120).slice(0, 50),
      taskFilter: (sp.get('tasks') ?? '').split(',').filter((x): x is TaskBucket => (TASK_BUCKETS as readonly string[]).includes(x)),
      sort: (SORTS as readonly string[]).includes(sp.get('sort') ?? '') ? sp.get('sort') as BoardSort : 'default',
    });
    return NextResponse.json({ ...board, viewerBitrixId: session.bitrixUserId }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[repeat-kanban]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось собрать канбан' }, { status: 500 });
  }
}

const KEY_RE = /^[ckx]\d{1,12}$/;

/** Заказчик действительно в списке этого менеджера (кэш «Моих заказчиков»). */
async function ownsClient(managerId: string, clientKey: string): Promise<boolean> {
  const rows = await fetchManagerCustomers(Number(managerId));
  return rows.some(r => r.clientKey === clientKey);
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.action !== 'string') return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });

  try {
    // ── Действия РОПа ──────────────────────────────────────────────────────
    const { scope, managers, canManage } = await context(session);
    // «Скрыть из пула» / «Вернуть в пул» — и менеджеру по СВОИМ заказчикам (владелец 20.10).
    if (body.action === 'hide' || body.action === 'unhide') {
      const ck = String(body.clientKey ?? '');
      const mid = String(body.managerId ?? '');
      const allowed = KEY_RE.test(ck) && (canManage ? managers.some(m => m.id === mid) : mid === session.bitrixUserId);
      if (!allowed || !(await ownsClient(mid, ck))) return NextResponse.json({ error: 'Заказчик не в вашей зоне' }, { status: 403 });
      if (body.action === 'hide') {
        await hideFromPool({ clientKey: ck, until: String(body.until ?? ''), comment: String(body.comment ?? ''), session });
      } else {
        await unhide(ck, session);
      }
      return NextResponse.json({ ok: true });
    }
    if (!canManage) return NextResponse.json({ error: 'Действие доступно РОПу' }, { status: 403 });
    const clientKey = String(body.clientKey ?? '');
    const managerId = String(body.managerId ?? '');
    if (!KEY_RE.test(clientKey) || !managers.some(m => m.id === managerId)) {
      return NextResponse.json({ error: 'Менеджер вне вашей зоны' }, { status: 403 });
    }
    if (!(await ownsClient(managerId, clientKey))) return NextResponse.json({ error: 'Заказчик не в списке менеджера' }, { status: 403 });

    if (body.action === 'create_task') {
      // Задача в проекте «Повторные продажи» Битрикса по ТЗ старого канбана (createDeal.ts).
      // Постановщик: нажал руководитель из цепочки менеджера — он (так делает и старый
      // канбан: директор ставит задачи менеджерам своих РОПов); нажал админ со «всей
      // компанией» — РОП менеджера по структуре (ТЗ п.3).
      const comment = typeof body.text === 'string' ? body.text.trim() : '';
      const creator = scope.full || !session.bitrixUserId
        ? (await ropOfManager(managerId)) ?? session.bitrixUserId
        : session.bitrixUserId;
      if (!creator) return NextResponse.json({ error: 'Не удалось определить постановщика: нет привязки к Битриксу' }, { status: 400 });
      const res = await createRepeatTask({ clientKey, fallbackManagerId: managerId, creatorBitrixId: creator, comment, commentAuthorId: session.bitrixUserId });
      return NextResponse.json(res);
    }

    if (body.action === 'review') {
      const decision = body.decision as ReviewDecision;
      if (!['brak', 'no_answer', 'return'].includes(decision)) return NextResponse.json({ error: 'Некорректное решение' }, { status: 400 });
      const dealId = Number(body.dealId);
      if (!Number.isInteger(dealId) || dealId <= 0) return NextResponse.json({ error: 'Нет сделки' }, { status: 400 });
      await decideReview({
        clientKey, dealId, decision,
        reason: typeof body.reason === 'string' ? body.reason : null,
        comment: typeof body.comment === 'string' ? body.comment : null,
        touchesDone: Number(body.touchesDone) || 0, session,
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'brak_now') {
      await markBrakNow({ clientKey, reason: String(body.reason ?? ''), comment: typeof body.comment === 'string' ? body.comment : null, session });
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'unbrak') {
      await restoreFromBrak(clientKey, session);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
  } catch (e) {
    if (e instanceof DealCreateError || e instanceof ReviewError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error('[repeat-kanban POST]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось выполнить действие' }, { status: 500 });
  }
}
