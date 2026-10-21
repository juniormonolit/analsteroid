// «Аналитика канбана повторных» v2 (владелец 20.10: «сортировка по заголовкам, иерархия с
// агрегацией по филиалам — сделайте охуенно»; ТЗ экрана — Fable). Источник — ежедневные снимки
// по менеджерам (repeat_kanban_daily) и журнал действий (repeat_kanban_events), миграция 231.
// Дерево и суммирование вверх строятся на клиенте (сортировка внутри уровня, раскрытие);
// сервер отдаёт строки менеджеров за 30 дней, оргструктуру и журнал дня.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { getCachedClientNames } from '@/lib/bitrix/clientNames';

export interface MgrDay {
  date: string; managerId: string; name: string; deptId: string | null; deptName: string | null;
  total: number; pool: number; poolHot: number; poolPotential: number;
  inWork: number; reached: number; funnel: number; funnelSum: number;
  review: number; hidden: number; brak: number;
  tasksOpen: number; tasksOverdue: number; tasksControl: number; noTask: number;
  actions: number; actionsByType: Record<string, number>; tasksCreated: number; tasksAccepted: number;
}
export interface OrgNode { id: string; name: string; parentId: string | null }
export interface JournalRow {
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
}

export type AnalyticsPeriod = 'day' | 'week' | 'month';
export const PERIOD_DAYS: Record<AnalyticsPeriod, number> = { day: 1, week: 7, month: 30 };

export async function fetchKanbanAnalytics(opts: { date: string; period?: AnalyticsPeriod; managerIds: string[] | null }): Promise<KanbanAnalytics> {
  const db = systemDb();
  // Период (владелец 21.10): действия и журнал — за весь период, состояние пула — последний снимок.
  const days = PERIOD_DAYS[opts.period ?? 'day'];
  const fromDate = new Date(new Date(`${opts.date}T12:00:00+03:00`).getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const from = `${fromDate}T00:00:00+03:00`, to = `${opts.date}T23:59:59.999+03:00`;
  const mf = opts.managerIds;

  const [snapDates, journal, org] = await Promise.all([
    db.query<{ d: string }>(`SELECT DISTINCT to_char(snap_date, 'YYYY-MM-DD') AS d FROM repeat_kanban_daily
                              WHERE snap_date <= $1::date ORDER BY 1 DESC LIMIT 30`, [opts.date]).then(r => r.rows.map(x => x.d)),
    db.query(
      `SELECT ts, coalesce(actor_name, actor_login) AS actor, actor_role, event_type, client_key, manager_id, column_before, deal_id, task_id, payload
         FROM repeat_kanban_events WHERE ts BETWEEN $1::timestamptz AND $2::timestamptz AND actor_type = 'user'
          ${mf ? 'AND manager_id = ANY($3::text[])' : ''}
        ORDER BY ts DESC LIMIT 5000`, mf ? [from, to, mf] : [from, to],
    ).then(r => r.rows as Record<string, unknown>[]).catch(() => []),
    analyticsDb().query<{ id: string; name: string; bid: string; pbid: string | null }>(
      `SELECT id::text AS id, name, bitrix_department_id::text AS bid, parent_bitrix_department_id::text AS pbid FROM sa.departments WHERE is_active`,
    ).then(r => {
      const byBid = new Map(r.rows.map(x => [x.bid, x.id]));
      return r.rows.map(x => ({ id: x.id, name: x.name, parentId: x.pbid ? byBid.get(x.pbid) ?? null : null }));
    }).catch(() => [] as OrgNode[]),
  ]);

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
      });
    }
  }

  const keys = [...new Set(journal.map(j => j.client_key as string | null).filter((k): k is string => !!k))];
  const names = await getCachedClientNames(keys).catch(() => new Map<string, string | null>());
  return {
    date: opts.date, fromDate, period: opts.period ?? 'day', snapDate: snapDates[0] ?? null, dates: [...snapDates].reverse(), mgr, org,
    journal: journal.map(r => ({
      ts: new Date(r.ts as string).toISOString(), actor: String(r.actor ?? '—'), actorRole: (r.actor_role as string | null) ?? null,
      type: String(r.event_type), clientKey: (r.client_key as string | null) ?? null,
      clientName: r.client_key ? names.get(String(r.client_key)) ?? null : null,
      managerId: (r.manager_id as string | null) ?? null, column: (r.column_before as string | null) ?? null,
      dealId: r.deal_id !== null ? Number(r.deal_id) : null, taskId: r.task_id !== null ? Number(r.task_id) : null,
      payload: (r.payload as Record<string, unknown>) ?? {},
    })),
  };
}
