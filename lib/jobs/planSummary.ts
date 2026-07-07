import { analyticsDb, systemDb } from '@/lib/db/clients';
import { getRedis } from '@/lib/cache/redis';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { loadManagerBranchMap } from '@/lib/marketing/sources';
import { toZonedTime } from 'date-fns-tz';
import { startOfDay, startOfYear, addDays } from 'date-fns';

const TZ = 'Europe/Moscow';
const REDIS_KEY = 'plan:summary';
const REDIS_TTL_SEC = 30 * 60; // джоба крутится раз в 10 мин — запас x3

// org_resolved_hierarchy.branch → метки филиалов из decomposition/plan_targets_year.
// Филиалы без записи в этой мапе (например «Екатеринбург») остаются собственной строкой
// без плана — plan_percent_* уйдёт в null, а не 0/NaN.
const BRANCH_LABELS: Record<string, string> = {
  'СПб': 'СПБ',
  'Москва/МО': 'МСК',
  'Краснодар': 'КРД',
};

interface BranchMetrics {
  name: string;
  fact_ytd: number;
  target_year: number | null;
  plan_percent_cumulative: number | null;
  plan_percent_pace: number | null;
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
  const [factByManager, branchByManager] = await Promise.all([
    getShipmentsFactByManager(fromIso, toExclIso),
    loadManagerBranchMap(),
  ]);

  let russiaTotal = 0;
  const byBranch = new Map<string, number>();

  for (const [managerId, amount] of factByManager) {
    russiaTotal += amount;
    const rawBranch = branchByManager.get(managerId);
    const label = rawBranch ? (BRANCH_LABELS[rawBranch] ?? rawBranch) : 'СПБ';
    byBranch.set(label, (byBranch.get(label) ?? 0) + amount);
  }

  return { russiaTotal, byBranch };
}

interface WorkingDayProgress {
  totalWorkingDays: number;
  workingDayIndexToday: number;
}

async function getWorkingDayProgress(year: number, todayStr: string): Promise<WorkingDayProgress | null> {
  const res = await systemDb().query<{ total_working: string; days_passed: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE is_working) AS total_working,
       COUNT(*) FILTER (WHERE is_working AND date <= $2::date) AS days_passed
     FROM working_calendar
     WHERE date >= $1::date AND date <= ($1::date + INTERVAL '1 year' - INTERVAL '1 day')`,
    [`${year}-01-01`, todayStr],
  );
  const totalWorkingDays = parseInt(res.rows[0]?.total_working ?? '0', 10);
  if (!totalWorkingDays) return null; // календарь на этот год не заполнен
  return {
    totalWorkingDays,
    workingDayIndexToday: parseInt(res.rows[0]?.days_passed ?? '0', 10),
  };
}

async function getPlanTargets(year: number): Promise<{ company: number | null; branch: Map<string, number> }> {
  const res = await systemDb().query<{ scope: string; scope_name: string | null; target_amount: string }>(
    `SELECT scope, scope_name, target_amount FROM plan_targets_year WHERE year = $1`,
    [year],
  );
  let company: number | null = null;
  const branch = new Map<string, number>();
  for (const row of res.rows) {
    const amount = Number(row.target_amount);
    if (row.scope === 'company') company = amount;
    else if (row.scope === 'branch' && row.scope_name) branch.set(row.scope_name, amount);
  }
  return { company, branch };
}

function computeMetrics(name: string, factYtd: number, targetYear: number | null, wd: WorkingDayProgress | null): BranchMetrics {
  const cumulative = pct(factYtd, targetYear);
  const pace = targetYear !== null && wd
    ? pct(factYtd, (targetYear / wd.totalWorkingDays) * wd.workingDayIndexToday)
    : null;
  return {
    name,
    fact_ytd: factYtd,
    target_year: targetYear,
    plan_percent_cumulative: cumulative,
    plan_percent_pace: pace,
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
  const fromIso = startOfYear(now).toISOString();
  const toExclIso = addDays(startOfDay(now), 1).toISOString();

  const [{ russiaTotal, byBranch }, targets, wd] = await Promise.all([
    getFactByBranch(fromIso, toExclIso),
    getPlanTargets(year),
    getWorkingDayProgress(year, todayStr),
  ]);

  if (!wd) {
    console.warn(`[planSummary] working_calendar пуст для ${year} года — plan_percent_pace будет null`);
  }

  const russia = computeMetrics('Россия', russiaTotal, targets.company, wd);

  const branchNames = new Set([...byBranch.keys(), ...targets.branch.keys()]);
  const branches = [...branchNames].map(name =>
    computeMetrics(name, byBranch.get(name) ?? 0, targets.branch.get(name) ?? null, wd),
  );

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
