// Сводка план/факт по подконтрольным отделам пользователя для ЛК (/profile).
// Отделы назначает админ (user_departments); менеджер попадает в отдел, если его
// собственный отдел ИЛИ любой предок по дереву departments — среди назначенных
// (первый совпавший предок; так дочерние отделы включаются неявно).
// План — manager_plans через short_login (как в lib/jobs/dailyMoscowReport.ts),
// факт — отгрузки MTD из БД (как в lib/jobs/planSummary.ts), темп — через общий
// хелпер lib/plans/dailyPlan (дефолт "месячный план ÷ 20", либо working_calendar,
// если супер-админ включил режим "производственный календарь").

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { loadDepartments, type DeptRow } from '@/lib/org/deptCategories';
import { getMonthWorkingDays } from '@/lib/plans/dailyPlan';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

const TZ = 'Europe/Moscow';

export interface DeptSummaryRow {
  departmentId: string; // uuid из departments.id
  name: string;
  planShipments: number;
  factShipments: number;
  pctPlan: number | null; // факт / план месяца
  pctPace: number | null; // факт / (план ÷ раб.дней × прошедших раб.дней)
}

export interface UserDeptSummary {
  month: string; // YYYY-MM-01
  updatedAt: string;
  workingDays: { inMonth: number; passed: number };
  departments: DeptSummaryRow[];
  total: Omit<DeptSummaryRow, 'departmentId' | 'name'>;
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

async function getShipmentsFactByManager(fromIso: string, toExclIso: string): Promise<Map<string, number>> {
  const allMetrics = await loadMetrics();
  const shipmentMetrics = allMetrics.filter(
    (m) => m.id === 'primary_shipments_amount' || m.id === 'repeat_shipments_amount'
  );
  const sql = buildCollectedSQL(shipmentMetrics, {
    idExpr: 'd.current_manager_id::text',
    groupBy: 'GROUP BY d.current_manager_id',
    notNullWhere: 'd.current_manager_id IS NOT NULL',
  });
  const out = new Map<string, number>();
  if (!sql) return out;
  const res = await analyticsDb().query<Record<string, unknown> & { dimension_id: string }>(sql, [fromIso, toExclIso]);
  for (const row of res.rows) {
    const sum = shipmentMetrics.reduce((acc, m) => {
      const v = row[m.id];
      return acc + (v !== null && v !== undefined ? Number(v) : 0);
    }, 0);
    out.set(row.dimension_id, sum);
  }
  return out;
}

/** Первый назначенный отдел вверх по дереву от собственного отдела менеджера. */
function resolveAssignedDept(
  ownDeptUuid: string | null,
  byId: Map<string, DeptRow>,
  byBitrixId: Map<string, DeptRow>,
  assignedByBitrixId: Map<string, string>, // bitrixId → uuid назначенного отдела
): string | null {
  if (!ownDeptUuid) return null;
  let cur: DeptRow | undefined = byId.get(ownDeptUuid);
  for (let guard = 0; cur && guard < 15; guard++) {
    const hit = assignedByBitrixId.get(cur.bitrixId);
    if (hit) return hit;
    cur = cur.parentBitrixId ? byBitrixId.get(cur.parentBitrixId) : undefined;
  }
  return null;
}

export async function computeUserDeptSummary(userId: string): Promise<UserDeptSummary> {
  // Оргструктура переехала в sa (задача Серёги 13.07): user_departments и
  // org_resolved_hierarchy читаем из analyticsDb (пул sa); manager_plans остаётся
  // в system (не org-таблица, синхронизируется отдельно) — читаем из systemDb.
  const org = analyticsDb();
  const sys = systemDb();
  const now = toZonedTime(new Date(), TZ);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const monthFirstDay = `${y}-${m}-01`;
  const todayStr = `${y}-${m}-${String(now.getDate()).padStart(2, '0')}`;
  const fromIso = fromZonedTime(`${monthFirstDay} 00:00:00`, TZ).toISOString();
  const tomorrow = new Date(`${todayStr}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const toExclIso = fromZonedTime(`${tomorrow.toISOString().slice(0, 10)} 00:00:00`, TZ).toISOString();

  const [assignedRes, { byId, byBitrixId }] = await Promise.all([
    org.query<{ department_id: string }>(
      `SELECT department_id::text AS department_id FROM sa.user_departments WHERE user_id = $1`,
      [userId]
    ),
    loadDepartments(),
  ]);

  const assignedUuids = assignedRes.rows.map((r) => r.department_id);
  const emptyTotal = { planShipments: 0, factShipments: 0, pctPlan: null, pctPace: null };
  if (!assignedUuids.length) {
    return {
      month: monthFirstDay,
      updatedAt: new Date().toISOString(),
      workingDays: { inMonth: 0, passed: 0 },
      departments: [],
      total: emptyTotal,
    };
  }

  // bitrixId назначенного отдела → его uuid (для поиска предка при проходе вверх)
  const assignedByBitrixId = new Map<string, string>();
  for (const uuid of assignedUuids) {
    const row = byId.get(uuid);
    if (row) assignedByBitrixId.set(row.bitrixId, uuid);
  }

  const [managersRes, plansRes, factByManager, wd] = await Promise.all([
    org.query<{ manager_id: string; department_id: string | null; short_login: string | null }>(
      `SELECT manager_bitrix_user_id::text AS manager_id, department_id::text AS department_id, short_login
         FROM sa.org_resolved_hierarchy WHERE is_active = true`
    ),
    sys.query<{ manager_login: string; plan_shipments: string }>(
      `SELECT manager_login, plan_shipments FROM manager_plans WHERE month = $1::date`,
      [monthFirstDay]
    ),
    getShipmentsFactByManager(fromIso, toExclIso),
    getMonthWorkingDays(monthFirstDay, todayStr),
  ]);

  const inMonth = wd.total;
  const passed = wd.passed;

  // Менеджер → назначенный отдел (uuid); заодно short_login → менеджер для планов
  const managerDept = new Map<string, string>(); // manager_id → dept uuid
  const managerByShortLogin = new Map<string, string>(); // short_login → manager_id
  for (const row of managersRes.rows) {
    const dept = resolveAssignedDept(row.department_id, byId, byBitrixId, assignedByBitrixId);
    if (dept) managerDept.set(row.manager_id, dept);
    if (row.short_login) managerByShortLogin.set(row.short_login, row.manager_id);
  }

  const plan = new Map<string, number>(); // dept uuid → план отгрузок
  for (const row of plansRes.rows) {
    const managerId = managerByShortLogin.get(row.manager_login);
    const dept = managerId ? managerDept.get(managerId) : undefined;
    if (!dept) continue;
    plan.set(dept, (plan.get(dept) ?? 0) + (parseFloat(row.plan_shipments) || 0));
  }

  const fact = new Map<string, number>(); // dept uuid → факт отгрузок MTD
  for (const [managerId, amount] of factByManager) {
    const dept = managerDept.get(managerId);
    if (!dept) continue;
    fact.set(dept, (fact.get(dept) ?? 0) + amount);
  }

  const departments: DeptSummaryRow[] = assignedUuids
    .map((uuid) => {
      const p = plan.get(uuid) ?? 0;
      const f = fact.get(uuid) ?? 0;
      const paceTarget = inMonth > 0 ? (p / inMonth) * passed : 0;
      return {
        departmentId: uuid,
        name: byId.get(uuid)?.name ?? '—',
        planShipments: p,
        factShipments: f,
        pctPlan: pct(f, p),
        pctPace: pct(f, paceTarget),
      };
    })
    .sort((a, b) => b.planShipments - a.planShipments || a.name.localeCompare(b.name, 'ru'));

  const totalPlan = departments.reduce((acc, d) => acc + d.planShipments, 0);
  const totalFact = departments.reduce((acc, d) => acc + d.factShipments, 0);
  const totalPace = inMonth > 0 ? (totalPlan / inMonth) * passed : 0;

  return {
    month: monthFirstDay,
    updatedAt: new Date().toISOString(),
    workingDays: { inMonth, passed },
    departments,
    total: {
      planShipments: totalPlan,
      factShipments: totalFact,
      pctPlan: pct(totalFact, totalPlan),
      pctPace: pct(totalFact, totalPace),
    },
  };
}
