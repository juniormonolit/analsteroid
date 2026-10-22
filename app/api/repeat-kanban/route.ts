import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { canManageRepeatKanbanSettings, canSeeRepeatKanbanAnalytics } from '@/lib/auth/modulesAccess';
import { ropScope, type RopScope } from '@/features/tv/engine/access';
import { scopeManagers } from '@/features/rop-kanban/engine/kanban';
import { fetchManagerCustomers } from '@/features/customers/engine/customers';
import { buildRepeatBoard, type BoardSort, type TaskBucket } from '@/features/repeat-kanban/engine/board';

const TASK_BUCKETS = ['none', 'unread', 'work', 'overdue', 'control', 'done'] as const;
const SORTS = ['default', 'ltv', 'potential', 'fresh', 'task', 'ev'] as const;
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { analyticsDb } from '@/lib/db/clients';
import { COLUMNS, type ColumnKey, type ReviewDecision } from '@/features/repeat-kanban/engine/config';
import { createRepeatTask, DealCreateError, ropOfManager, closeDealAsLost } from '@/features/repeat-kanban/engine/createDeal';
import { logEvent, newRequestId, type KanbanEventType } from '@/features/repeat-kanban/engine/log';
import { decideHideRequest, decideReview, hideFromPool, markBrakNow, requestHide, restoreFromBrak, ReviewError, unhide } from '@/features/repeat-kanban/engine/reviews';
import { fetchManagerLoad } from '@/features/repeat-kanban/engine/board';
import { rememberDealClient } from '@/features/repeat-kanban/engine/dealFixes';
import { enqueue, fetchQueueItem, issueNow, removeByClient, removeFromQueue, setBoost, type DeadlineRule } from '@/features/repeat-kanban/engine/queue';
import { fetchKanbanSettings, listTemplates, renderTemplate } from '@/features/repeat-kanban/engine/settings';

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
    // Загрузка менеджеров (норма задач) — рядом с именами в пикере.
    if (sp.get('meta') === '1') {
      const load = await fetchManagerLoad(managers.map(m => m.id));
      return NextResponse.json({ managers: managers.map(m => ({ ...m, load: load[m.id] ?? 0 })) }, { headers: { 'Cache-Control': 'no-store' } });
    }
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
      outcome: sp.get('outcome') === 'won' || sp.get('outcome') === 'lost' ? sp.get('outcome') as 'won' | 'lost' : null,
      search: (sp.get('q') ?? '').trim().slice(0, 80) || null,
      sort: (SORTS as readonly string[]).includes(sp.get('sort') ?? '') ? sp.get('sort') as BoardSort : 'default',
    });
    return NextResponse.json({ ...board, viewerBitrixId: session.bitrixUserId, canSeeAnalytics: canSeeRepeatKanbanAnalytics(session), canManageSettings: canManageRepeatKanbanSettings(session) }, { headers: { 'Cache-Control': 'no-store' } });
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

  // Журнал (миграция 231): одна кнопка = один request_id; колонку карточки присылает клиент.
  const rid = newRequestId();
  const columnBefore = typeof body.column === 'string' ? body.column.slice(0, 40) : null;
  try {
    // ── Действия РОПа ──────────────────────────────────────────────────────
    const { scope, managers, canManage } = await context(session);
    // «Предложить скрыть» — менеджер по СВОЕМУ заказчику (владелец 21.10: скрывает только РОП,
    // менеджер предлагает — аудит Fable: «менеджер может прятать неудобных»).
    if (body.action === 'request_hide') {
      const ck = String(body.clientKey ?? '');
      const mid = String(body.managerId ?? '');
      const allowed = KEY_RE.test(ck) && (mid === session.bitrixUserId || (canManage && managers.some(m => m.id === mid)));
      if (!allowed || !(await ownsClient(mid, ck))) return NextResponse.json({ error: 'Заказчик не в вашей зоне' }, { status: 403 });
      await requestHide({ clientKey: ck, managerId: mid, until: String(body.until ?? ''), comment: String(body.comment ?? ''), session });
      await logEvent(session, { type: 'hide_requested', requestId: rid, clientKey: ck, managerId: mid, columnBefore, payload: { until: body.until, comment: body.comment } });
      return NextResponse.json({ ok: true });
    }
    // «Скрыть из пула» / «Вернуть в пул» — только РОП (с 21.10; раньше — и менеджер по своим).
    if (body.action === 'hide' || body.action === 'unhide') {
      const ck = String(body.clientKey ?? '');
      const mid = String(body.managerId ?? '');
      const allowed = KEY_RE.test(ck) && canManage && managers.some(m => m.id === mid);
      if (!allowed || !(await ownsClient(mid, ck))) return NextResponse.json({ error: canManage ? 'Заказчик не в вашей зоне' : 'Скрывает РОП — предложите скрыть' }, { status: 403 });
      if (body.action === 'hide') {
        await hideFromPool({ clientKey: ck, until: String(body.until ?? ''), comment: String(body.comment ?? ''), session });
        await logEvent(session, { type: 'hidden', requestId: rid, clientKey: ck, managerId: mid, columnBefore, payload: { until: body.until, comment: body.comment } });
      } else {
        await unhide(ck, session);
        await logEvent(session, { type: 'unhidden', requestId: rid, clientKey: ck, managerId: mid, columnBefore });
      }
      return NextResponse.json({ ok: true });
    }
    if (!canManage) return NextResponse.json({ error: 'Действие доступно РОПу' }, { status: 403 });

    // ── Очередь задач (миграция 237, владелец 22.10) ──────────────────────────
    if (body.action.startsWith('queue_')) {
      const zone = new Set(managers.map(m => m.id));
      if (body.action === 'queue_add') {
        if (!session.bitrixUserId) return NextResponse.json({ error: 'Нет привязки к Битриксу — некому быть постановщиком' }, { status: 400 });
        const raw = (Array.isArray(body.items) ? body.items : []).slice(0, 3000) as { clientKey?: unknown; managerId?: unknown }[];
        // Проверка «заказчик у этого менеджера» — по менеджеру один раз (список из снимка).
        const own = new Map<string, Set<string>>();
        const items: { clientKey: string; managerId: string }[] = [];
        let skipped = 0;
        for (const it of raw) {
          const ck = String(it.clientKey ?? ''), mid = String(it.managerId ?? '');
          if (!KEY_RE.test(ck) || !zone.has(mid)) { skipped++; continue; }
          if (!own.has(mid)) own.set(mid, new Set((await fetchManagerCustomers(Number(mid))).map(r => r.clientKey)));
          if (!own.get(mid)!.has(ck)) { skipped++; continue; }
          items.push({ clientKey: ck, managerId: mid });
        }
        let newResponsibleId: string | null = null;
        if (typeof body.newManagerId === 'string' && /^\d{1,10}$/.test(body.newManagerId)) {
          if (!(await fetchKanbanSettings()).reassignEnabled) return NextResponse.json({ error: 'Смена менеджера выключена в настройках канбана' }, { status: 400 });
          if (!zone.has(body.newManagerId)) return NextResponse.json({ error: 'Новый менеджер не из вашей зоны' }, { status: 403 });
          newResponsibleId = body.newManagerId;
        }
        const rule = (['window', 'today', '3', '7'] as const).includes(body.deadlineRule as DeadlineRule) ? body.deadlineRule as DeadlineRule : 'window';
        const time = typeof body.deadlineTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.deadlineTime) ? body.deadlineTime : '19:00';
        const r = await enqueue({
          items, queuedBy: session.bitrixUserId, queuedByName: session.displayName,
          templateId: typeof body.templateId === 'number' ? body.templateId : null,
          comment: typeof body.comment === 'string' && body.comment.trim() ? body.comment.trim().slice(0, 3000) : null,
          deadlineRule: rule, deadlineTime: time, newResponsibleId,
        });
        return NextResponse.json({ ...r, skipped });
      }
      const qid = Number(body.id);
      const item = Number.isInteger(qid) && qid > 0 ? await fetchQueueItem(qid) : null;
      if (!item || !zone.has(item.managerId)) return NextResponse.json({ error: 'Позиция не найдена в вашей зоне' }, { status: 404 });
      if (body.action === 'queue_remove') { await removeFromQueue(qid, 'manual', session.bitrixUserId); return NextResponse.json({ ok: true }); }
      if (body.action === 'queue_boost') { await setBoost(qid, Number(body.boost) || 0); return NextResponse.json({ ok: true }); }
      if (body.action === 'queue_issue_now') return NextResponse.json(await issueNow(qid, session.bitrixUserId));
      return NextResponse.json({ error: 'Неизвестное действие очереди' }, { status: 400 });
    }

    const clientKey = String(body.clientKey ?? '');
    const managerId = String(body.managerId ?? '');
    if (!KEY_RE.test(clientKey) || !managers.some(m => m.id === managerId)) {
      return NextResponse.json({ error: 'Менеджер вне вашей зоны' }, { status: 403 });
    }
    if (!(await ownsClient(managerId, clientKey))) return NextResponse.json({ error: 'Заказчик не в списке менеджера' }, { status: 403 });

    // Постановка задачи (кнопка и «Вернуть менеджеру» на разборе) — один путь (createDeal.ts).
    const runTask = async (comment: string, logType?: KanbanEventType) => {
      // Постановщик — тот, кто нажал (владелец 21.10, Коваленко: «от того, кто ставит»; раньше у
      // полного доступа подставлялся РОП менеджера по структуре — все задачи шли от Осипова).
      const creator = session.bitrixUserId ?? (await ropOfManager(managerId));
      if (!creator) throw new DealCreateError('Не удалось определить постановщика: нет привязки к Битриксу');
      const deadlineDate = typeof body.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.deadline) ? body.deadline : null;
      const deadlineTime = typeof body.deadlineTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.deadlineTime) ? body.deadlineTime : '19:00';
      // Срок в прошлом (выбрали «сегодня», а время уже прошло) — до любых действий со сделкой.
      if (deadlineDate && new Date(`${deadlineDate}T${deadlineTime}:00+03:00`).getTime() < Date.now()) {
        throw new DealCreateError(`Срок ${deadlineDate.split('-').reverse().join('.')} ${deadlineTime} уже прошёл — выберите время позже`);
      }
      // «И сменить менеджера на …» — РОП, включено в настройках, новый менеджер — из зоны.
      let newResponsibleId: string | null = null;
      if (typeof body.newManagerId === 'string' && /^\d{1,10}$/.test(body.newManagerId) && body.newManagerId !== managerId) {
        if (!(await fetchKanbanSettings()).reassignEnabled) throw new DealCreateError('Смена менеджера выключена в настройках канбана');
        if (!managers.some(m => m.id === body.newManagerId)) throw new DealCreateError('Новый менеджер не из вашей зоны');
        newResponsibleId = body.newManagerId;
      }
      const res = await createRepeatTask({ clientKey, fallbackManagerId: managerId, creatorBitrixId: creator, comment, commentAuthorId: session.bitrixUserId, deadlineDate, deadlineTime, newResponsibleId });
      // Поставили «Сразу» — позиция этого заказчика в очереди больше не нужна.
      await removeByClient(clientKey, 'manual', session.bitrixUserId).catch(() => {});
      // Синк может не донести клиента новой сделки (21.10: так карточки оставались в пуле).
      rememberDealClient(res.dealId, clientKey);
      const type = logType ?? (res.dealMode === 'created' ? 'deal_task_created' : res.dealMode === 'reopened' ? 'deal_returned_from_reject' : 'task_created');
      await logEvent(session, { type, requestId: rid, clientKey, managerId, columnBefore, dealId: res.dealId, taskId: res.taskId,
        payload: { comment, creator, responsible: res.responsibleId, deadline: deadlineDate, deadlineTime, templateId: typeof body.templateId === 'number' ? body.templateId : null,
          dealMode: res.dealMode, reassignedTo: newResponsibleId, reassignWorkflowId: res.reassignWorkflowId ?? null } });
      if (res.chatPosted) await logEvent(session, { type: 'task_comment_posted', requestId: rid, clientKey, managerId, columnBefore, dealId: res.dealId, taskId: res.taskId });
      if (newResponsibleId) await logEvent(session, { type: 'manager_reassigned', requestId: rid, clientKey, managerId, columnBefore, dealId: res.dealId, taskId: res.taskId,
        payload: { from: managerId, to: newResponsibleId, workflowId: res.reassignWorkflowId ?? null } });
      return res;
    };

    if (body.action === 'create_task') {
      let comment = typeof body.text === 'string' ? body.text.trim() : '';
      // Массовая постановка (владелец 21.10): текста нет, есть шаблон — заполняем по заказчику.
      if (!comment && typeof body.templateId === 'number') {
        const tpl = (await listTemplates()).find(t => t.id === body.templateId);
        if (tpl) comment = (await renderTemplate(tpl.body, { clientKey, managerId })).trim();
      }
      return NextResponse.json(await runTask(comment));
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
      // Брак → сделка закрывается и в Битриксе (22.10). Отказная уже закрыта — вернётся already_closed.
      const dealClosed = decision === 'brak'
        ? await closeDealAsLost({ dealId, clientKey, reason: String(body.reason ?? ''), comment: typeof body.comment === 'string' ? body.comment : null, authorId: session.bitrixUserId })
            .catch(e => { console.warn('[repeat-kanban] закрытие сделки при браке:', e instanceof Error ? e.message : e); return 'error' as const; })
        : null;
      await logEvent(session, { type: 'reject_reviewed', requestId: rid, clientKey, managerId, columnBefore, dealId,
        payload: { decision, reason: body.reason ?? null, comment: body.comment ?? null, attempts: Number(body.touchesDone) || 0, dealClosed } });
      // «Вернуть менеджеру» (21.10, сделка 263762: решение записалось, а сделка осталась в отказе и
      // задачи не было — менеджер ничего не видел): отказная сделка возвращается в первую стадию,
      // менеджеру — задача с комментарием РОПа; сделка открыта (3 попытки без дозвона) — только задача.
      if (decision === 'return') {
        const res = await runTask(typeof body.comment === 'string' ? body.comment.trim() : '');
        return NextResponse.json({ ok: true, ...res });
      }
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'brak_now') {
      await markBrakNow({ clientKey, reason: String(body.reason ?? ''), comment: typeof body.comment === 'string' ? body.comment : null, session });
      // Открытая повторная сделка карточки закрывается в Битриксе в стадию по причине (22.10).
      const brakDealId = Number(body.dealId);
      const dealClosed = Number.isInteger(brakDealId) && brakDealId > 0
        ? await closeDealAsLost({ dealId: brakDealId, clientKey, reason: String(body.reason ?? ''), comment: typeof body.comment === 'string' ? body.comment : null, authorId: session.bitrixUserId })
            .catch(e => { console.warn('[repeat-kanban] закрытие сделки при браке:', e instanceof Error ? e.message : e); return 'error' as const; })
        : null;
      await logEvent(session, { type: 'rejected_direct', requestId: rid, clientKey, managerId, columnBefore, dealId: brakDealId > 0 ? brakDealId : null,
        payload: { reason: body.reason, comment: body.comment ?? null, dealClosed } });
      return NextResponse.json({ ok: true, dealClosed });
    }

    if (body.action === 'decide_hide') {
      const accept = body.accept === true;
      const req = await decideHideRequest({ clientKey, accept, comment: typeof body.comment === 'string' ? body.comment : null, session });
      await logEvent(session, { type: accept ? 'hide_request_accepted' : 'hide_request_declined', requestId: rid, clientKey, managerId, columnBefore,
        payload: { until: req?.until, comment: req?.comment, by: req?.by } });
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'unbrak') {
      await restoreFromBrak(clientKey, session);
      await logEvent(session, { type: 'reject_cleared', requestId: rid, clientKey, managerId, columnBefore });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
  } catch (e) {
    if (e instanceof DealCreateError || e instanceof ReviewError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error('[repeat-kanban POST]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось выполнить действие' }, { status: 500 });
  }
}
