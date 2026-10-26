// «Аналитика канбана повторных» v2 (владелец 20.10: «сортировка по заголовкам, иерархия с
// агрегацией по филиалам — сделайте охуенно»; ТЗ экрана — Fable). Источник — ежедневные снимки
// по менеджерам (repeat_kanban_daily) и журнал действий (repeat_kanban_events), миграция 231.
// Дерево и суммирование вверх строятся на клиенте (сортировка внутри уровня, раскрытие);
// сервер отдаёт строки менеджеров за 30 дней, оргструктуру и журнал дня.
// Журнал (21.10): клики канбана + события Битрикса из sa (bitrixEvents.ts) с пометкой источника.
import { systemDb } from '@/lib/db/clients';
import { getCachedClientNames } from '@/lib/bitrix/clientNames';
import { fetchBitrixEvents, type BitrixActorCounts } from './bitrixEvents';
import { fetchManagerDirectory, fetchOrg, periodBounds, PERIOD_LEN, type OrgNode } from './saLookups';
export type { OrgNode } from './saLookups';
export type { BitrixActorCounts } from './bitrixEvents';

export interface MgrDay {
  date: string; managerId: string; name: string; deptId: string | null; deptName: string | null;
  total: number; pool: number; poolHot: number; poolPotential: number;
  inWork: number; reached: number; funnel: number; funnelSum: number;
  review: number; hidden: number; brak: number;
  tasksOpen: number; tasksOverdue: number; tasksControl: number; noTask: number;
  actions: number; actionsByType: Record<string, number>; tasksCreated: number; tasksAccepted: number;
  /** В работе с задачей РОПа (миграция 235; до 21.10 — 0). */
  workedByTask: number;
}
export interface JournalRow {
  /** kanban — клик в канбане (repeat_kanban_events); bitrix — событие из копии Битрикса (sa). */
  source: 'kanban' | 'bitrix';
  ts: string; actor: string; actorRole: string | null; type: string; clientKey: string | null; clientName: string | null;
  managerId: string | null; column: string | null; dealId: number | null; taskId: number | null; payload: Record<string, unknown>;
}
export interface KanbanAnalytics {
  date: string;
  /** Начало периода (для «день» = date). */
  fromDate: string;
  period: AnalyticsPeriod;
  /** Последняя дата снимка ≤ date (снимок делается в 23:30 — сегодняшнего ещё может не быть). */
  snapDate: string | null;
  dates: string[];
  mgr: MgrDay[];
  org: OrgNode[];
  journal: JournalRow[];
  /** События Битрикса по людям (имя → счётчики) — по всем событиям, журнал может быть обрезан. */
  bitrixCounts: Record<string, BitrixActorCounts>;
  /** Стадии/звонки в журнале обрезаны потолком (счётчики — полные). */
  bitrixTruncated: boolean;
}

export type AnalyticsPeriod = 'day' | 'week' | 'month' | 'all';
export const PERIOD_DAYS = PERIOD_LEN;

export async function fetchKanbanAnalytics(opts: { date: string; period?: AnalyticsPeriod; managerIds: string[] | null }): Promise<KanbanAnalytics> {
  const db = systemDb();
  // Период (владелец 21.10): действия и журнал — за весь период, состояние пула — последний снимок.
  const { fromDate, from, to } = periodBounds(opts.date, opts.period ?? 'day');
  const mf = opts.managerIds;

  const [snapDates, journal, org, directory] = await Promise.all([
    db.query<{ d: string }>(`SELECT DISTINCT to_char(snap_date, 'YYYY-MM-DD') AS d FROM repeat_kanban_daily
                              WHERE snap_date <= $1::date ORDER BY 1 DESC LIMIT 30`, [opts.date]).then(r => r.rows.map(x => x.d)),
    db.query(
      `SELECT ts, coalesce(actor_name, actor_login) AS actor, actor_role, event_type, client_key, manager_id, column_before, deal_id, task_id, payload
         FROM repeat_kanban_events WHERE ts BETWEEN $1::timestamptz AND $2::timestamptz AND actor_type = 'user'
          ${mf ? 'AND manager_id = ANY($3::text[])' : ''}
        ORDER BY ts DESC LIMIT 5000`, mf ? [from, to, mf] : [from, to],
    ).then(r => r.rows as Record<string, unknown>[]).catch(() => []),
    fetchOrg(),
    fetchManagerDirectory(),
  ]);
  // События Битрикса — после журнала кликов: по нему отсеиваются смены стадий, сделанные канбаном.
  // Сбой sa не роняет аналитику: журнал останется только с кликами.
  const bx = await fetchBitrixEvents({
    from, to, managerIds: mf, directory,
    kanban: journal.map(j => ({ dealId: j.deal_id !== null ? Number(j.deal_id) : null, ts: new Date(j.ts as string).toISOString() })),
  }).catch(e => {
    console.warn('[repeat-kanban analytics] события Битрикса не прочитались:', e instanceof Error ? e.message : e);
    return { events: [], counts: {}, truncated: false };
  });
  const nameOf = (id: string | null) => (id ? directory.get(id)?.name ?? `#${id}` : '—');

  const mgr: MgrDay[] = [];
  if (snapDates.length) {
    const r = await db.query(
      `SELECT to_char(snap_date, 'YYYY-MM-DD') AS d, * FROM repeat_kanban_daily
        WHERE snap_date BETWEEN $1::date AND $2::date ${mf ? 'AND manager_id = ANY($3::text[])' : ''}`,
      mf ? [snapDates[snapDates.length - 1], snapDates[0], mf] : [snapDates[snapDates.length - 1], snapDates[0]],
    );
    for (const x of r.rows as Record<string, unknown>[]) {
      mgr.push({
        date: String(x.d), managerId: String(x.manager_id), name: String(x.manager_name ?? x.manager_id),
        deptId: (x.department_id as string | null) ?? null, deptName: (x.department_name as string | null) ?? null,
        total: Number(x.total), pool: Number(x.pool), poolHot: Number(x.pool_hot), poolPotential: Number(x.pool_potential),
        inWork: Number(x.in_work), reached: Number(x.reached), funnel: Number(x.funnel), funnelSum: Number(x.funnel_sum),
        review: Number(x.review), hidden: Number(x.hidden), brak: Number(x.brak),
        tasksOpen: Number(x.tasks_open), tasksOverdue: Number(x.tasks_overdue), tasksControl: Number(x.tasks_control), noTask: Number(x.no_task_in_work),
        actions: Number(x.actions), actionsByType: (x.actions_by_type as Record<string, number>) ?? {},
        tasksCreated: Number(x.tasks_created), tasksAccepted: Number(x.tasks_accepted),
        workedByTask: Number(x.worked_by_task ?? 0),
      });
    }
  }

  const keys = [...new Set([...journal.map(j => j.client_key as string | null), ...bx.events.map(e => e.clientKey)].filter((k): k is string => !!k))];
  const names = await getCachedClientNames(keys).catch(() => new Map<string, string | null>());
  return {
    date: opts.date, fromDate, period: opts.period ?? 'day', snapDate: snapDates[0] ?? null, dates: [...snapDates].reverse(), mgr, org,
    journal: [...journal.map(r => ({
      source: 'kanban' as const, ts: new Date(r.ts as string).toISOString(), actor: String(r.actor ?? '—'), actorRole: (r.actor_role as string | null) ?? null,
      type: String(r.event_type), clientKey: (r.client_key as string | null) ?? null,
      clientName: r.client_key ? names.get(String(r.client_key)) ?? null : null,
      managerId: (r.manager_id as string | null) ?? null, column: (r.column_before as string | null) ?? null,
      dealId: r.deal_id !== null ? Number(r.deal_id) : null, taskId: r.task_id !== null ? Number(r.task_id) : null,
      payload: (r.payload as Record<string, unknown>) ?? {},
    })), ...bx.events.map(e => ({
      source: 'bitrix' as const, ts: e.ts, actor: nameOf(e.actorId), actorRole: null, type: e.type, clientKey: e.clientKey,
      clientName: e.clientKey ? names.get(e.clientKey) ?? null : null, managerId: e.managerId, column: null,
      dealId: e.dealId, taskId: e.taskId, payload: e.payload,
    }))].sort((a, b) => b.ts.localeCompare(a.ts)),
    bitrixCounts: Object.fromEntries(Object.entries(bx.counts).map(([id, c]) => [nameOf(id), c])),
    bitrixTruncated: bx.truncated,
  };
}
