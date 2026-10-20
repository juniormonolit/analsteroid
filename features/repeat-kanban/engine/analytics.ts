// «Аналитика канбана повторных» v1 (владелец 20.10: «что по отчёту по канбану, где смотреть?»).
// Читает журнал действий (repeat_kanban_events) и ежедневные снимки (repeat_kanban_daily,
// миграция 231). Полный экран по схеме Fable (когорты, атрибуция выручки, рейтинги с
// антиметриками) — в BACKLOG, когда накопятся данные; здесь — то, что полезно с первого дня.
import { systemDb } from '@/lib/db/clients';

export interface ActorDay {
  actor: string; role: string | null;
  total: number; byType: Record<string, number>; clients: number; lastAt: string;
}
export interface DeptDay {
  date: string; department: string;
  managers: number; total: number; pool: number; poolHot: number; poolPotential: number;
  inWork: number; funnel: number; hidden: number; brak: number;
  workedPct: number; workedPctStrict: number;
  actions: number; tasksCreated: number; tasksAccepted: number; tasksControl: number; tasksOverdue: number;
}
export interface JournalRow {
  ts: string; actor: string; type: string; clientKey: string | null; managerId: string | null;
  column: string | null; dealId: number | null; taskId: number | null; payload: Record<string, unknown>;
}
export interface KanbanAnalytics { date: string; actors: ActorDay[]; depts: DeptDay[]; dates: string[]; journal: JournalRow[] }

export async function fetchKanbanAnalytics(opts: { date: string; managerIds: string[] | null }): Promise<KanbanAnalytics> {
  const db = systemDb();
  const from = `${opts.date}T00:00:00+03:00`, to = `${opts.date}T23:59:59.999+03:00`;
  const mgrFilter = opts.managerIds ? 'AND manager_id = ANY($3::text[])' : '';
  const params = (extra: unknown[]) => (opts.managerIds ? [...extra, opts.managerIds] : extra);

  const [ev, journal, daily, dates] = await Promise.all([
    db.query<{ actor: string; role: string | null; event_type: string; n: string; clients: string; last_at: Date }>(
      `SELECT coalesce(actor_name, actor_login) AS actor, max(actor_role) AS role, event_type, count(*)::text AS n,
              count(DISTINCT client_key)::text AS clients, max(ts) AS last_at
         FROM repeat_kanban_events WHERE ts BETWEEN $1::timestamptz AND $2::timestamptz AND actor_type = 'user' ${mgrFilter}
        GROUP BY 1, 3`, params([from, to]),
    ),
    db.query(
      `SELECT ts, coalesce(actor_name, actor_login) AS actor, event_type, client_key, manager_id, column_before, deal_id, task_id, payload
         FROM repeat_kanban_events WHERE ts BETWEEN $1::timestamptz AND $2::timestamptz ${mgrFilter}
        ORDER BY ts DESC LIMIT 300`, params([from, to]),
    ),
    db.query(
      `SELECT to_char(snap_date, 'YYYY-MM-DD') AS d, coalesce(department_name, 'Без отдела') AS dept, count(*)::int AS managers,
              sum(total)::int AS total, sum(pool)::int AS pool, sum(pool_hot)::int AS pool_hot, sum(pool_potential)::bigint AS pool_potential,
              sum(in_work)::int AS in_work, sum(funnel)::int AS funnel, sum(hidden)::int AS hidden, sum(brak)::int AS brak,
              sum(review)::int AS review,
              sum(actions)::int AS actions, sum(tasks_created)::int AS tasks_created, sum(tasks_accepted)::int AS tasks_accepted,
              sum(tasks_control)::int AS tasks_control, sum(tasks_overdue)::int AS tasks_overdue
         FROM repeat_kanban_daily WHERE snap_date BETWEEN ($1::date - 29) AND $1::date ${opts.managerIds ? 'AND manager_id = ANY($2::text[])' : ''}
        GROUP BY 1, 2 ORDER BY 1 DESC, 2`, opts.managerIds ? [opts.date, opts.managerIds] : [opts.date],
    ),
    db.query<{ d: string }>(`SELECT DISTINCT to_char(snap_date, 'YYYY-MM-DD') AS d FROM repeat_kanban_daily ORDER BY 1 DESC LIMIT 60`),
  ]).catch(() => [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }] as never);

  const actorsMap = new Map<string, ActorDay>();
  for (const r of ev.rows) {
    const a = actorsMap.get(r.actor) ?? { actor: r.actor, role: r.role, total: 0, byType: {}, clients: 0, lastAt: '' };
    a.byType[r.event_type] = Number(r.n);
    a.total += Number(r.n);
    a.clients = Math.max(a.clients, Number(r.clients));
    const at = new Date(r.last_at).toISOString();
    if (at > a.lastAt) a.lastAt = at;
    actorsMap.set(r.actor, a);
  }
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    date: opts.date,
    actors: [...actorsMap.values()].sort((a, b) => b.total - a.total),
    depts: (daily.rows as Record<string, unknown>[]).map(r => {
      const total = Number(r.total), pool = Number(r.pool);
      return {
        date: String(r.d), department: String(r.dept), managers: Number(r.managers), total, pool, poolHot: Number(r.pool_hot),
        poolPotential: Number(r.pool_potential), inWork: Number(r.in_work), funnel: Number(r.funnel), hidden: Number(r.hidden), brak: Number(r.brak),
        workedPct: pct(total - pool, total), workedPctStrict: pct(Number(r.in_work) + Number(r.funnel), total),
        actions: Number(r.actions), tasksCreated: Number(r.tasks_created), tasksAccepted: Number(r.tasks_accepted),
        tasksControl: Number(r.tasks_control), tasksOverdue: Number(r.tasks_overdue),
      };
    }),
    dates: dates.rows.map(r => r.d),
    journal: (journal.rows as Record<string, unknown>[]).map(r => ({
      ts: new Date(r.ts as string).toISOString(), actor: String(r.actor ?? '—'), type: String(r.event_type),
      clientKey: (r.client_key as string | null) ?? null, managerId: (r.manager_id as string | null) ?? null,
      column: (r.column_before as string | null) ?? null, dealId: r.deal_id !== null ? Number(r.deal_id) : null,
      taskId: r.task_id !== null ? Number(r.task_id) : null, payload: (r.payload as Record<string, unknown>) ?? {},
    })),
  };
}
