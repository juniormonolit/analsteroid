import { analyticsDb, systemDb } from '@/lib/db/clients';
import { getRedis } from '@/lib/cache/redis';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { loadManagerBranchMap } from '@/lib/marketing/sources';
import {
  BRANCH_LABELS,
  CATEGORY_ORDER,
  loadDepartments,
  getManagerDeptIds,
  resolveDeptCategory,
} from '@/lib/org/deptCategories';
import { getMonthWorkingDays } from '@/lib/plans/dailyPlan';
import { toZonedTime } from 'date-fns-tz';
import { startOfDay, startOfYear, addDays } from 'date-fns';

const TZ = 'Europe/Moscow';
const REDIS_KEY = 'plan:summary';
const REDIS_TTL_SEC = 30 * 60; // джоба крутится раз в 10 мин — запас x3

interface BranchMetrics {
  name: string;
  fact_ytd: number;
  target_year: number | null;
  /** Цель «на сегодня» (не годовая!) — знаменатель темпа (п.10.07, см. computeAndCachePlanSummary):
   *  сумма месячных планов ЗАВЕРШЁННЫХ месяцев года + план текущего месяца × доля прошедших
   *  рабочих дней. null, если планов на эти месяцы вообще нет в manager_plans. */
  target_to_date: number | null;
  plan_percent_cumulative: number | null;
  plan_percent_pace: number | null;
  departments?: BranchMetrics[];
}

export interface PlanSummary {
  updated_at: string;
  russia: BranchMetrics;
  branches: BranchMetrics[];
}

function pct(numerator: number, denominator: number | null): number | null {
  if (denominator === null || denominator === 0) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}

async function getShipmentsFactByManager(fromIso: string, toExclIso: string): Promise<Map<string, number>> {
  const allMetrics = await loadMetrics();
  const shipmentMetrics = allMetrics.filter(m =>
    m.id === 'primary_shipments_amount' || m.id === 'repeat_shipments_amount',
  );

  const sql = buildCollectedSQL(shipmentMetrics, {
    idExpr: 'd.current_manager_id::text',
    groupBy: 'GROUP BY d.current_manager_id',
    notNullWhere: 'd.current_manager_id IS NOT NULL',
  });

  const factByManager = new Map<string, number>();
  if (!sql) return factByManager;

  const res = await analyticsDb().query<Record<string, unknown> & { dimension_id: string }>(
    sql, [fromIso, toExclIso],
  );
  for (const row of res.rows) {
    const sum = shipmentMetrics.reduce((acc, m) => {
      const v = row[m.id];
      return acc + (v !== null && v !== undefined ? Number(v) : 0);
    }, 0);
    factByManager.set(row.dimension_id, sum);
  }
  return factByManager;
}

async function getFactByBranch(fromIso: string, toExclIso: string) {
  const [factByManager, branchByManager, managerDeptIds, { byId, byBitrixId }] = await Promise.all([
    getShipmentsFactByManager(fromIso, toExclIso),
    loadManagerBranchMap(),
    getManagerDeptIds(),
    loadDepartments(),
  ]);

  let russiaTotal = 0;
  const byBranch = new Map<string, number>();
  const byDept = new Map<string, number>(); // key = `${branchLabel}:${category}`

  for (const [managerId, amount] of factByManager) {
    russiaTotal += amount;
    const rawBranch = branchByManager.get(managerId);
    const label = rawBranch ? (BRANCH_LABELS[rawBranch] ?? rawBranch) : 'СПБ';
    byBranch.set(label, (byBranch.get(label) ?? 0) + amount);

    const category = resolveDeptCategory(label, managerDeptIds.get(managerId) ?? null, byId, byBitrixId);
    if (category) {
      const key = `${label}:${category}`;
      byDept.set(key, (byDept.get(key) ?? 0) + amount);
    }
  }

  return { russiaTotal, byBranch, byDept };
}

async function getPlanTargets(year: number): Promise<{ company: number | null; branch: Map<string, number>; department: Map<string, number> }> {
  const res = await systemDb().query<{ scope: string; scope_name: string | null; target_amount: string }>(
    `SELECT scope, scope_name, target_amount FROM plan_targets_year WHERE year = $1`,
    [year],
  );
  let company: number | null = null;
  const branch = new Map<string, number>();
  const department = new Map<string, number>(); // key = `${branchLabel}:${category}`
  for (const row of res.rows) {
    const amount = Number(row.target_amount);
    if (row.scope === 'company') company = amount;
    else if (row.scope === 'branch' && row.scope_name) branch.set(row.scope_name, amount);
    else if (row.scope === 'department' && row.scope_name) department.set(row.scope_name, amount);
  }
  return { company, branch, department };
}

// short_login ('#8') → manager_bitrix_user_id — тот же маппинг, что уже собирают
// вручную lib/profile/deptSummary.ts и lib/jobs/dailyMoscowReport.ts для чтения
// manager_plans; здесь нужен, чтобы посчитанные по менеджеру месячные планы разложить
// по филиалу/категории тем же способом, что и факт (getFactByBranch выше).
async function loadShortLoginToManagerId(): Promise<Map<string, string>> {
  // Оргструктура переехала в sa (задача Серёги 13.07): читаем из analyticsDb.
  const res = await analyticsDb().query<{ manager_id: string; short_login: string }>(
    `SELECT manager_bitrix_user_id::text AS manager_id, short_login
       FROM sa.org_resolved_hierarchy WHERE is_active = true AND short_login IS NOT NULL`,
  );
  return new Map(res.rows.map(r => [r.short_login, r.manager_id]));
}

interface YtdPlanTargets {
  company: number;
  branch: Map<string, number>;
  department: Map<string, number>;
  /** Месяцы года (YYYY-MM-01) по текущий включительно, для которых в manager_plans
   *  вообще НЕТ ни одной строки — цель по ним честно посчитана как 0, план не выдуман. */
  missingMonths: string[];
}

/**
 * Решение владельца 10.07 (ОТМЕНЯЕТ ÷365-календарный темп от 08.07, см. WORKLOG):
 * «темп» на Сводной должен считаться помесячно — цель на сегодня = сумма месячных
 * планов ВСЕХ ЗАВЕРШЁННЫХ месяцев года + план ТЕКУЩЕГО месяца, взятый с весом
 * "прошедшие рабочие дни ÷ рабочих дней в месяце" (тот же режим "÷20"/working_calendar,
 * что и везде в приложении — lib/plans/dailyPlan::getMonthWorkingDays).
 *
 * Источник месячных планов — manager_plans (та же таблица, что ЛК/дневной Bitrix-отчёт),
 * агрегированная до компании/филиала/категории через branch+dept-маппинг менеджера.
 * Это ДРУГОЙ источник данных, чем годовой plan_targets_year (тот — top-down цифры из
 * /decomposition, эта — bottom-up по менеджерам); суммы за них НЕ обязаны совпадать
 * (проверено 10.07: полугодовая сумма manager_plans меньше половины годового target_year —
 * см. отчёт задачи), это ожидаемо и не является багом.
 */
async function getYtdPlanTargets(
  yearStart: string,
  currentMonthFirst: string,
  currentMonthWeight: number,
): Promise<YtdPlanTargets> {
  const [plansRes, shortLoginMap, branchByManager, managerDeptIds, { byId, byBitrixId }] = await Promise.all([
    systemDb().query<{ manager_login: string; month: string; plan_shipments: string }>(
      `SELECT manager_login, to_char(month, 'YYYY-MM-DD') AS month, plan_shipments
         FROM manager_plans WHERE month >= $1::date AND month <= $2::date`,
      [yearStart, currentMonthFirst],
    ),
    loadShortLoginToManagerId(),
    loadManagerBranchMap(),
    getManagerDeptIds(),
    loadDepartments(),
  ]);

  let company = 0;
  const branch = new Map<string, number>();
  const department = new Map<string, number>();
  const monthsWithData = new Set<string>();

  for (const row of plansRes.rows) {
    const amount = Number(row.plan_shipments) || 0;
    if (amount !== 0) monthsWithData.add(row.month);

    const managerId = shortLoginMap.get(row.manager_login);
    if (!managerId) continue; // менеджер уволен/переименован — как и в deptSummary.ts, тихо пропускаем

    const weight = row.month === currentMonthFirst ? currentMonthWeight : 1;
    const contribution = amount * weight;

    company += contribution;
    const rawBranch = branchByManager.get(managerId);
    const label = rawBranch ? (BRANCH_LABELS[rawBranch] ?? rawBranch) : 'СПБ';
    branch.set(label, (branch.get(label) ?? 0) + contribution);

    const category = resolveDeptCategory(label, managerDeptIds.get(managerId) ?? null, byId, byBitrixId);
    if (category) {
      const key = `${label}:${category}`;
      department.set(key, (department.get(key) ?? 0) + contribution);
    }
  }

  const expectedMonths: string[] = [];
  for (let cur = yearStart; cur <= currentMonthFirst; ) {
    expectedMonths.push(cur);
    const d = new Date(`${cur}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    cur = d.toISOString().slice(0, 10);
  }
  const missingMonths = expectedMonths.filter(m => !monthsWithData.has(m));

  return { company, branch, department, missingMonths };
}

function computeMetrics(name: string, factYtd: number, targetYear: number | null, targetToDate: number | null): BranchMetrics {
  return {
    name,
    fact_ytd: factYtd,
    target_year: targetYear,
    target_to_date: targetToDate,
    plan_percent_cumulative: pct(factYtd, targetYear),
    plan_percent_pace: pct(factYtd, targetToDate),
  };
}

export async function computeAndCachePlanSummary(): Promise<void> {
  const client = getRedis();
  if (!client) {
    console.warn('[planSummary] Redis не настроен, пропускаю расчёт');
    return;
  }

  const now = toZonedTime(new Date(), TZ);
  const year = now.getFullYear();
  const todayStr = now.toISOString().slice(0, 10);
  const yearStart = `${year}-01-01`;
  const currentMonthFirst = `${todayStr.slice(0, 7)}-01`;
  const fromIso = startOfYear(now).toISOString();
  const toExclIso = addDays(startOfDay(now), 1).toISOString();

  const [{ russiaTotal, byBranch, byDept }, targets, monthWd] = await Promise.all([
    getFactByBranch(fromIso, toExclIso),
    getPlanTargets(year),
    getMonthWorkingDays(currentMonthFirst, todayStr),
  ]);

  const currentMonthWeight = monthWd.total > 0 ? monthWd.passed / monthWd.total : 0;
  const ytd = await getYtdPlanTargets(yearStart, currentMonthFirst, currentMonthWeight);

  if (ytd.missingMonths.length > 0) {
    console.warn(`[planSummary] нет планов в manager_plans за месяцы: ${ytd.missingMonths.join(', ')} — цель на сегодня по ним = 0`);
  }

  const russia = computeMetrics('Россия', russiaTotal, targets.company, ytd.company);

  const branchNames = new Set([...byBranch.keys(), ...targets.branch.keys(), ...ytd.branch.keys()]);
  const branches = [...branchNames].map(name => {
    const metrics = computeMetrics(name, byBranch.get(name) ?? 0, targets.branch.get(name) ?? null, ytd.branch.get(name) ?? null);

    const prefix = `${name}:`;
    const categories = new Set(
      [...byDept.keys(), ...targets.department.keys(), ...ytd.department.keys()]
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length)),
    );
    if (categories.size > 0) {
      metrics.departments = [...categories]
        .sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b))
        .map(cat => {
          const key = `${prefix}${cat}`;
          return computeMetrics(cat, byDept.get(key) ?? 0, targets.department.get(key) ?? null, ytd.department.get(key) ?? null);
        });
    }
    return metrics;
  });

  const summary: PlanSummary = {
    updated_at: now.toISOString(),
    russia,
    branches,
  };

  await client.set(REDIS_KEY, JSON.stringify(summary), 'EX', REDIS_TTL_SEC);
}

export async function getCachedPlanSummary(): Promise<PlanSummary | null> {
  const client = getRedis();
  if (!client) return null;
  const raw = await client.get(REDIS_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as PlanSummary;
}
