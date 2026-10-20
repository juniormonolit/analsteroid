import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { ropScope, type RopScope } from '@/features/tv/engine/access';
import { scopeManagers } from '@/features/rop-kanban/engine/kanban';
import { fetchManagerCustomers } from '@/features/customers/engine/customers';
import { buildRepeatBoard } from '@/features/repeat-kanban/engine/board';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { COLUMNS, type ColumnKey, type ReviewDecision } from '@/features/repeat-kanban/engine/config';
import { createRepeatTask, DealCreateError, ropOfManager } from '@/features/repeat-kanban/engine/createDeal';
import { decideReview, restoreFromBrak, ReviewError } from '@/features/repeat-kanban/engine/reviews';

// Канбан повторных продаж (решения владельца 20.10, REPEAT_KANBAN_SPEC.md).
// Гейт — section.repeat_kanban (ролям продаж, миграция 230). Зона — ropScope() сессии,
// как у «Канбана РОПа»: РОП — свои отделы с поддеревом, менеджер — только себя.
// Действия РОПа (задача, сделка, разбор) — только над менеджерами своей зоны и только
// по заказчикам этого менеджера. Задачи — в Битриксе (проект 118), закрывает их постановщик.
export const dynamic = 'force-dynamic';

const COLUMN_KEYS = new Set<string>(COLUMNS.map(c => c.key));

/** Менеджеры выбранных отделов. DepartmentPicker отдаёт UUID узлов дерева оргструктуры
 *  (вместе с потомками) — резолвер тот же, что у «Моей команды» (lib/org/teamRoster). */
async function managersOfDepartments(deptIds: string[]): Promise<Set<string>> {
  const rows = await resolveManagersForDepartments(deptIds);
  return new Set(rows.map(m => String(m.managerId)));
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
  const rawMgr = sp.get('manager');
  const type = sp.get('type');
  const limits: Partial<Record<ColumnKey, number>> = {};
  for (const [k, v] of sp) {
    if (k.startsWith('n_') && COLUMN_KEYS.has(k.slice(2)) && /^\d{1,4}$/.test(v)) limits[k.slice(2) as ColumnKey] = Number(v);
  }
  try {
    const ctx = await context(session);
    const deptIds = (sp.get('dept') ?? '').split(',').filter(x => /^[0-9a-f-]{1,40}$/i.test(x)).slice(0, 300);
    // Отделы сужают зону, но не расширяют: чужой отдел в параметре даст пустой список.
    const inDepts = deptIds.length ? await managersOfDepartments(deptIds) : null;
    const managers = inDepts ? ctx.managers.filter(m => inDepts.has(m.id)) : ctx.managers;
    const canManage = ctx.canManage;
    const selected = rawMgr && managers.some(m => m.id === rawMgr) ? rawMgr : null;
    const board = await buildRepeatBoard({
      managers, selectedManager: selected, typeFilter: type && /^[a-z_]{2,30}$/.test(type) ? type : null, limits, canManage,
    });
    return NextResponse.json(board, { headers: { 'Cache-Control': 'no-store' } });
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
      const res = await createRepeatTask({ clientKey, fallbackManagerId: managerId, creatorBitrixId: creator, comment });
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
