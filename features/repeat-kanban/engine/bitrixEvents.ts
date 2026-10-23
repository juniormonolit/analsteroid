// События Битрикса для журнала аналитики канбана повторных (владелец 21.10: журнал писал только
// клики в канбане — то, что сделано в Битриксе, не было видно). Читаем из sa, в журнал не
// пишем (миграция 231: «события Битрикса досчитываются из sa — там они уже есть с авторами»).
//
// Что берём и откуда:
//   * bx_task_created — задача проекта 118 создана в периоде (sa.bitrix_task_current.created_at,
//     автор created_by). Задачи, поставленные из канбана, уже в журнале кликом с тем же task_id
//     (deal_task_created / task_created / deal_returned_from_reject) — их пропускаем;
//   * bx_task_submitted — задача СЕЙЧАС «ждёт контроля» (status 4), а последнее изменение
//     (changed_at) — в периоде: менеджер сдал на проверку. Время приблизительное: истории
//     статусов в копии нет, changed_at — последняя правка задачи;
//   * bx_task_closed — задача завершена (status 5, closed_at в периоде). Кто закрыл —
//     closed_by, если колонка есть в копии; иначе — постановщик (как «принято» в снимке).
//     «Вернул на доработку» по текущему состоянию не восстановить — нужна история статусов;
//   * bx_stage — смена стадии повторной сделки (воронки 2/3, sa.deal_events, автор manager_id).
//     Смена, которую сделал сам канбан (та же сделка ±10 мин от клика), не дублируется;
//   * bx_call_reached / bx_call_attempt — звонки по сделкам задач проекта после постановки
//     (va.calls): дозвон > 20 с, как на доске, и прочие исходящие попытки.
// Счётчики по людям считаются по ВСЕМ событиям; в журнал стадии и звонки идут с потолком —
// за 30 дней по всей компании их десятки тысяч.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { REPEAT_PROJECT_GROUP_ID } from './config';
import { clientKeyOfDeal, fetchDealsById, type MgrInfo } from './saLookups';

const GOOD_CALL_SEC = 20;
/** Задачи, созданные раньше периода, — по их сделкам тоже ловим звонки периода. */
const TASK_LOOKBACK_DAYS = 60;
/** Потолок строк одного вида (стадии, звонки) в журнале. */
const JOURNAL_CAP = 3000;
const DEDUP_MS = 10 * 60_000;

export type BitrixEventType = 'bx_task_created' | 'bx_task_submitted' | 'bx_task_closed' | 'bx_stage' | 'bx_call_reached' | 'bx_call_attempt';

export interface BitrixEvent {
  ts: string; actorId: string | null; type: BitrixEventType; managerId: string | null;
  dealId: number | null; taskId: number | null; clientKey: string | null; payload: Record<string, unknown>;
}

/** Счётчики событий Битрикса по человеку (Битрикс-id). */
export interface BitrixActorCounts { tasks: number; submitted: number; closed: number; stages: number; calls: number; reached: number }

interface TaskRow {
  task_id: string; deal_id: string | null; title: string | null; status: number | null; created_by: string | null;
  responsible_id: string | null; created_at: Date; changed_at: Date | null; closed_at: Date | null; closed_by?: string | null;
}

async function fetchTasks(from: string, to: string): Promise<{ rows: TaskRow[]; hasClosedBy: boolean }> {
  const lookback = new Date(new Date(from).getTime() - TASK_LOOKBACK_DAYS * 86_400_000).toISOString();
  // Индекс (group_id, created_at): created_at ограничен снизу; закрытые/сданные в периоде,
  // но созданные ещё раньше, добираем по тому же group_id.
  const sql = (closedBy: boolean) => `
    SELECT task_id, deal_id, title, status, created_by::text AS created_by, responsible_id::text AS responsible_id,
           created_at, changed_at, closed_at${closedBy ? ', closed_by::text AS closed_by' : ''}
      FROM sa.bitrix_task_current
     WHERE group_id = $1 AND NOT is_deleted
       AND (created_at BETWEEN $2::timestamptz AND $4::timestamptz
            OR closed_at BETWEEN $3::timestamptz AND $4::timestamptz
            OR (status = 4 AND changed_at BETWEEN $3::timestamptz AND $4::timestamptz))`;
  const params = [REPEAT_PROJECT_GROUP_ID, lookback, from, to];
  try {
    return { rows: (await analyticsDb().query<TaskRow>(sql(true), params)).rows, hasClosedBy: true };
  } catch {
    // В копии может не быть closed_by — тогда закрывшим считаем постановщика.
    return { rows: (await analyticsDb().query<TaskRow>(sql(false), params)).rows, hasClosedBy: false };
  }
}

export async function fetchBitrixEvents(opts: {
  from: string; to: string; managerIds: string[] | null;
  /** Клики канбана периода (deal_id + время) — чтобы не дублировать смены стадий, сделанные канбаном. */
  kanban: { dealId: number | null; ts: string }[];
  directory: Map<string, MgrInfo>;
}): Promise<{ events: BitrixEvent[]; counts: Record<string, BitrixActorCounts>; truncated: boolean }> {
  const fromMs = new Date(opts.from).getTime(), toMs = new Date(opts.to).getTime();
  const inPeriod = (d: Date | null) => !!d && new Date(d).getTime() >= fromMs && new Date(d).getTime() <= toMs;
  const mf = opts.managerIds ? new Set(opts.managerIds) : null;
  const mfArr = opts.managerIds ?? [];

  const [{ rows: tasks, hasClosedBy }, stages] = await Promise.all([
    fetchTasks(opts.from, opts.to),
    analyticsDb().query<{ deal_id: string; stage_id: string; stage_name: string | null; event_at: Date; manager_id: string | null }>(
      `SELECT e.deal_id, e.stage_id, s.name AS stage_name, e.event_at, e.manager_id::text AS manager_id
         FROM sa.deal_events e LEFT JOIN sa.stages s ON s.id = e.stage_id
        WHERE e.event_at BETWEEN $1::timestamptz AND $2::timestamptz
          AND (e.stage_id LIKE 'C2:%' OR e.stage_id LIKE 'C3:%')
          ${mf ? 'AND e.manager_id::text = ANY($3::text[])' : ''}
        ORDER BY e.event_at DESC`,
      mf ? [opts.from, opts.to, mfArr] : [opts.from, opts.to],
    ).then(r => r.rows).catch(() => []),
  ]);

  // Задачи, созданные кликом канбана, — уже в журнале (по task_id).
  const createdIds = tasks.filter(t => inPeriod(t.created_at)).map(t => Number(t.task_id));
  const kanbanTaskIds = createdIds.length ? await systemDb().query<{ task_id: string }>(
    `SELECT DISTINCT task_id FROM repeat_kanban_events WHERE task_id = ANY($1::bigint[]) AND ts >= $2::timestamptz`,
    [createdIds, new Date(fromMs - 86_400_000).toISOString()],
  ).then(r => new Set(r.rows.map(x => Number(x.task_id)))).catch(() => new Set<number>()) : new Set<number>();

  // Звонки периода по сделкам задач (после постановки — фильтр ниже).
  const taskStartByDeal = new Map<number, number>();
  for (const t of tasks) {
    if (t.deal_id === null) continue;
    const d = Number(t.deal_id), at = new Date(t.created_at).getTime();
    if (at <= toMs && (!taskStartByDeal.has(d) || at < taskStartByDeal.get(d)!)) taskStartByDeal.set(d, at);
  }
  const calls = taskStartByDeal.size ? await analyticsDb().query<{ deal_id: string; called_at: Date; manager_id: string | null; duration_seconds: number | null; result: string | null; direction: string | null }>(
    `SELECT deal_id, called_at, manager_id::text AS manager_id, duration_seconds, result, direction FROM va.calls
      WHERE deal_id = ANY($1::bigint[]) AND called_at BETWEEN $2::timestamptz AND $3::timestamptz
        AND failed_at_stage IS NULL`,
    [[...taskStartByDeal.keys()], opts.from, opts.to],
  ).then(r => r.rows).catch(() => []) : [];

  // Заказчик — по сделке (PK-поиск, без прохода по sa.deals).
  const dealIds = new Set<number>();
  for (const t of tasks) if (t.deal_id !== null) dealIds.add(Number(t.deal_id));
  for (const s of stages) dealIds.add(Number(s.deal_id));
  const deals = await fetchDealsById([...dealIds]).catch(() => new Map());
  const keyOf = (dealId: number | null) => { const d = dealId !== null ? deals.get(dealId) : undefined; return d ? clientKeyOfDeal(d) : null; };

  const events: BitrixEvent[] = [];
  const counts: Record<string, BitrixActorCounts> = {};
  const bump = (actor: string | null, k: keyof BitrixActorCounts) => {
    if (!actor) return;
    const c = counts[actor] ??= { tasks: 0, submitted: 0, closed: 0, stages: 0, calls: 0, reached: 0 };
    c[k]++;
  };
  const okMgr = (id: string | null) => !mf || (!!id && mf.has(id));

  for (const t of tasks) {
    const taskId = Number(t.task_id), dealId = t.deal_id !== null ? Number(t.deal_id) : null;
    if (!okMgr(t.responsible_id)) continue;
    const base = { managerId: t.responsible_id, dealId, taskId, clientKey: keyOf(dealId) };
    if (inPeriod(t.created_at) && !kanbanTaskIds.has(taskId)) {
      events.push({ ...base, ts: new Date(t.created_at).toISOString(), actorId: t.created_by, type: 'bx_task_created', payload: { title: t.title ?? '' } });
      bump(t.created_by, 'tasks');
    }
    if (Number(t.status) === 4 && inPeriod(t.changed_at)) {
      events.push({ ...base, ts: new Date(t.changed_at!).toISOString(), actorId: t.responsible_id, type: 'bx_task_submitted', payload: { approx: true } });
      bump(t.responsible_id, 'submitted');
    }
    if (Number(t.status) === 5 && inPeriod(t.closed_at)) {
      const by = (hasClosedBy ? t.closed_by : null) ?? t.created_by;
      events.push({ ...base, ts: new Date(t.closed_at!).toISOString(), actorId: by, type: 'bx_task_closed',
        payload: { accepted: !!by && by === t.created_by && by !== t.responsible_id, closedByKnown: hasClosedBy && !!t.closed_by } });
      bump(by, 'closed');
    }
  }

  // Клики канбана по сделке — для отсева смен стадий, которые сделал сам канбан.
  const kanbanByDeal = new Map<number, number[]>();
  for (const k of opts.kanban) if (k.dealId) { const l = kanbanByDeal.get(k.dealId) ?? []; l.push(new Date(k.ts).getTime()); kanbanByDeal.set(k.dealId, l); }
  let stageRows = 0, callRows = 0, truncated = false;
  for (const s of stages) {
    const dealId = Number(s.deal_id), at = new Date(s.event_at).getTime();
    if ((kanbanByDeal.get(dealId) ?? []).some(k => Math.abs(k - at) <= DEDUP_MS)) continue;
    bump(s.manager_id, 'stages');
    if (stageRows++ >= JOURNAL_CAP) { truncated = true; continue; }
    events.push({ ts: new Date(at).toISOString(), actorId: s.manager_id, type: 'bx_stage', managerId: s.manager_id, dealId, taskId: null,
      clientKey: keyOf(dealId), payload: { stageId: s.stage_id, stageName: s.stage_name ?? s.stage_id } });
  }
  calls.sort((a, b) => new Date(b.called_at).getTime() - new Date(a.called_at).getTime());
  for (const c of calls) {
    const dealId = Number(c.deal_id), at = new Date(c.called_at).getTime();
    if (at < (taskStartByDeal.get(dealId) ?? Infinity) || !okMgr(c.manager_id)) continue;
    const sec = Number(c.duration_seconds ?? 0), inbound = c.direction === 'inbound';
    const missed = c.result === 'missed' || sec === 0;
    if (inbound && missed) continue; // пропущенный входящий — не действие менеджера
    const reached = !missed && sec > GOOD_CALL_SEC;
    bump(c.manager_id, 'calls'); if (reached) bump(c.manager_id, 'reached');
    if (callRows++ >= JOURNAL_CAP) { truncated = true; continue; }
    events.push({ ts: new Date(at).toISOString(), actorId: c.manager_id, type: reached ? 'bx_call_reached' : 'bx_call_attempt',
      managerId: c.manager_id, dealId, taskId: null, clientKey: keyOf(dealId), payload: { sec, inbound } });
  }
  return { events, counts, truncated };
}
