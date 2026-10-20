// Ежедневный снимок канбана повторных продаж (миграция 231; владелец 20.10: «каждый рабочий
// день замерять, насколько пул каждого отдела проработан, сколько действий совершено, и
// записывать»; схема — Fable). Ряд на (дату, менеджера): остатки по колонкам на конец дня +
// потоки за день. Отдел — снимком на момент, переназначения историю не переписывают.
// Отдел и РОП повторки потом складываются из строк менеджеров и журнала действий.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { buildRepeatBoard } from './board';
import { REPEAT_PROJECT_GROUP_ID } from './config';

const mskDate = (ms = Date.now()) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 10);

export interface SnapshotResult { date: string; managers: number; written: number; skipped: number; ms: number }

export async function buildDailySnapshot(date = mskDate()): Promise<SnapshotResult> {
  const t0 = Date.now();
  const dayStart = `${date}T00:00:00+03:00`;
  const dayEnd = `${date}T23:59:59.999+03:00`;
  const dow = new Date(`${date}T12:00:00+03:00`).getUTCDay();
  const isWorkday = dow !== 0 && dow !== 6; // производственный календарь — v2

  const mgrs = (await analyticsDb().query<{ id: string; name: string; dept_id: string | null; dept_name: string | null }>(
    `SELECT manager_bitrix_user_id::text AS id, manager_name AS name, department_id::text AS dept_id, department_name AS dept_name
       FROM sa.org_resolved_hierarchy WHERE is_active`,
  )).rows;

  // Потоки за день одним запросом на всех.
  const [acts, tasksCreated, tasksAccepted] = await Promise.all([
    systemDb().query<{ manager_id: string; event_type: string; n: string }>(
      `SELECT manager_id, event_type, count(*)::text AS n FROM repeat_kanban_events
        WHERE ts BETWEEN $1::timestamptz AND $2::timestamptz AND actor_type = 'user' AND manager_id IS NOT NULL
        GROUP BY 1, 2`, [dayStart, dayEnd],
    ).then(r => r.rows).catch(() => []),
    analyticsDb().query<{ mgr: string; n: string }>(
      `SELECT responsible_id::text AS mgr, count(*)::text AS n FROM sa.bitrix_task_current
        WHERE group_id = $3 AND NOT is_deleted AND created_at BETWEEN $1::timestamptz AND $2::timestamptz GROUP BY 1`,
      [dayStart, dayEnd, REPEAT_PROJECT_GROUP_ID],
    ).then(r => new Map(r.rows.map(x => [x.mgr, Number(x.n)]))),
    analyticsDb().query<{ mgr: string; n: string }>(
      `SELECT responsible_id::text AS mgr, count(*)::text AS n FROM sa.bitrix_task_current
        WHERE group_id = $3 AND NOT is_deleted AND status = 5 AND closed_at BETWEEN $1::timestamptz AND $2::timestamptz GROUP BY 1`,
      [dayStart, dayEnd, REPEAT_PROJECT_GROUP_ID],
    ).then(r => new Map(r.rows.map(x => [x.mgr, Number(x.n)]))),
  ]);
  const actsBy = new Map<string, Record<string, number>>();
  for (const a of acts) {
    const m = actsBy.get(a.manager_id) ?? {};
    m[a.event_type] = Number(a.n);
    actsBy.set(a.manager_id, m);
  }

  let written = 0, skipped = 0;
  for (const m of mgrs) {
    try {
      const b = await buildRepeatBoard({ managers: [{ id: m.id, name: m.name }], selectedManagers: [], typeFilter: null, canManage: false, skipNames: true });
      const k = b.kpi;
      if (!k) { skipped++; continue; }
      const total = k.pool + k.inWork + k.funnel + k.review + k.hidden;
      if (total + k.brak === 0) { skipped++; continue; } // у менеджера нет заказчиков
      const cols = Object.fromEntries(b.columns.map(c => [c.key, c.total]));
      const tasksOpen = b.columns.filter(c => c.key.startsWith('touch') || c.key.startsWith('st_')).reduce((s, c) => s + (c.total - c.noTask), 0);
      const by = actsBy.get(m.id) ?? {};
      await systemDb().query(
        `INSERT INTO repeat_kanban_daily (snap_date, manager_id, manager_name, department_id, department_name, is_workday,
           total, pool, pool_hot, pool_potential, in_work, reached, funnel, funnel_sum, review, hidden, brak,
           worked_pct, worked_pct_strict, tasks_open, tasks_overdue, tasks_control, no_task_in_work, columns,
           actions, actions_by_type, tasks_created, tasks_accepted, built_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28, now())
         ON CONFLICT (snap_date, manager_id) DO UPDATE SET
           manager_name = EXCLUDED.manager_name, department_id = EXCLUDED.department_id, department_name = EXCLUDED.department_name,
           is_workday = EXCLUDED.is_workday, total = EXCLUDED.total, pool = EXCLUDED.pool, pool_hot = EXCLUDED.pool_hot,
           pool_potential = EXCLUDED.pool_potential, in_work = EXCLUDED.in_work, reached = EXCLUDED.reached, funnel = EXCLUDED.funnel,
           funnel_sum = EXCLUDED.funnel_sum, review = EXCLUDED.review, hidden = EXCLUDED.hidden, brak = EXCLUDED.brak,
           worked_pct = EXCLUDED.worked_pct, worked_pct_strict = EXCLUDED.worked_pct_strict, tasks_open = EXCLUDED.tasks_open,
           tasks_overdue = EXCLUDED.tasks_overdue, tasks_control = EXCLUDED.tasks_control, no_task_in_work = EXCLUDED.no_task_in_work,
           columns = EXCLUDED.columns, actions = EXCLUDED.actions, actions_by_type = EXCLUDED.actions_by_type,
           tasks_created = EXCLUDED.tasks_created, tasks_accepted = EXCLUDED.tasks_accepted, built_at = now()`,
        [date, m.id, m.name, m.dept_id, m.dept_name, isWorkday,
         total, k.pool, cols.pool_hot ?? 0, Math.round(k.poolPotential), k.inWork, k.reached, k.funnel, Math.round(k.funnelSum),
         k.review, k.hidden, k.brak,
         total ? Math.round(((total - k.pool) / total) * 1000) / 10 : 0,
         total ? Math.round(((k.inWork + k.funnel) / total) * 1000) / 10 : 0,
         tasksOpen, k.tasksOverdue, k.tasksControl, k.noTaskInWork, JSON.stringify(cols),
         Object.values(by).reduce((s, n) => s + n, 0), JSON.stringify(by),
         tasksCreated.get(m.id) ?? 0, tasksAccepted.get(m.id) ?? 0],
      );
      written++;
    } catch (e) {
      skipped++;
      console.warn(`[repeat-kanban snapshot] менеджер ${m.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return { date, managers: mgrs.length, written, skipped, ms: Date.now() - t0 };
}
