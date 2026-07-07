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

// ── Категории продаж внутри филиала (для раскрытия карточки в «Сводной») ──────────
// Резолвятся по РЕАЛЬНОЙ иерархии Bitrix-отделов (departments.parent_bitrix_department_id),
// а не по department_name самого сотрудника — например, «Команда Осипов» попадает в «ОС»
// только через цепочку предков (Команда Осипов < Департамент ОС < Отдел продаж).
// Порядок важен: более специфичные узлы (ЖБИ/Металл) проверяются раньше их родителя (НЦ),
// иначе все сотрудники «Отдел ЖБИ» попали бы в «НЦ» по совпадению с родительским узлом.
// Соответствие подтверждено владельцем 2026-07-07 (см. migrations/047_plan_targets_department.sql).
interface DeptAnchor { branch: string; category: string; name: string }

const ANCESTOR_ANCHORS: DeptAnchor[] = [
  { branch: 'СПБ', category: 'НЦ ЖБИ',    name: 'Отдел ЖБИ' },
  { branch: 'СПБ', category: 'НЦ Металл', name: 'Отдел Металлопроката' },
  { branch: 'СПБ', category: 'НЦ',        name: 'Департамент НЦ' },
  { branch: 'СПБ', category: 'ОС',        name: 'Департамент ОС' },
  { branch: 'СПБ', category: 'ОС',        name: 'Департамент ЮЛ' }, // «Звезды Монолита» + сам узел
  { branch: 'МСК', category: 'ОС',        name: 'МСК ОС' },
  { branch: 'МСК', category: 'НЦ',        name: 'МСК НЦ' },
  { branch: 'МСК', category: 'ЖБИ',       name: 'МСК ЖБИ' },
  { branch: 'КРД', category: 'ОС',        name: 'КРД ОС' },
  { branch: 'КРД', category: 'НЦ',        name: 'КРД НЦ' },
];

// Голый «Отдел продаж» без своего подотдела (2 чел. по СПб) — матчится ТОЛЬКО по
// собственному имени узла сотрудника, не по потомкам: это корень дерева продаж для
// ВСЕХ филиалов, ancestor-match захватил бы МСК и КРД тоже.
const EXACT_ANCHORS: DeptAnchor[] = [
  { branch: 'СПБ', category: 'ОС', name: 'Отдел продаж' },
];

// Порядок отображения категорий внутри карточки филиала.
const CATEGORY_ORDER = ['ОС', 'НЦ', 'НЦ ЖБИ', 'НЦ Металл', 'ЖБИ'];

interface DeptRow { bitrixId: string; name: string; parentBitrixId: string | null }

let _depts: Map<string, DeptRow> | null = null; // keyed by departments.id (uuid, org_resolved_hierarchy.department_id)
let _deptsByBitrixId: Map<string, DeptRow> | null = null;
let _deptsAt = 0;

async function loadDepartments(): Promise<{ byId: Map<string, DeptRow>; byBitrixId: Map<string, DeptRow> }> {
  if (_depts && Date.now() - _deptsAt < 30 * 60 * 1000) return { byId: _depts, byBitrixId: _deptsByBitrixId! };
  const res = await systemDb().query<{ id: string; bitrix_department_id: string; name: string; parent_bitrix_department_id: string | null }>(
    'SELECT id::text AS id, bitrix_department_id, name, parent_bitrix_department_id FROM departments',
  );
  const byId = new Map<string, DeptRow>();
  const byBitrixId = new Map<string, DeptRow>();
  for (const r of res.rows) {
    const row: DeptRow = { bitrixId: r.bitrix_department_id, name: r.name, parentBitrixId: r.parent_bitrix_department_id };
    byId.set(r.id, row);
    byBitrixId.set(r.bitrix_department_id, row);
  }
  _depts = byId;
  _deptsByBitrixId = byBitrixId;
  _deptsAt = Date.now();
  return { byId, byBitrixId };
}

async function getManagerDeptIds(): Promise<Map<string, string | null>> {
  const res = await systemDb().query<{ manager_bitrix_user_id: string; department_id: string | null }>(
    `SELECT manager_bitrix_user_id::text AS manager_bitrix_user_id, department_id::text AS department_id
       FROM org_resolved_hierarchy WHERE is_active = true`,
  );
  return new Map(res.rows.map(r => [r.manager_bitrix_user_id, r.department_id]));
}

function resolveDeptCategory(
  branchLabel: string,
  departmentId: string | null,
  byId: Map<string, DeptRow>,
  byBitrixId: Map<string, DeptRow>,
): string | null {
  if (!departmentId) return null;
  const own = byId.get(departmentId);
  if (!own) return null;

  for (const a of EXACT_ANCHORS) {
    if (a.branch === branchLabel && own.name === a.name) return a.category;
  }

  let cur: DeptRow | undefined = own;
  for (let guard = 0; cur && guard < 15; guard++) {
    for (const a of ANCESTOR_ANCHORS) {
      if (a.branch === branchLabel && cur.name === a.name) return a.category;
    }
    cur = cur.parentBitrixId ? byBitrixId.get(cur.parentBitrixId) : undefined;
  }
  return null;
}

interface BranchMetrics {
  name: string;
  fact_ytd: number;
  target_year: number | null;
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

  const [{ russiaTotal, byBranch, byDept }, targets, wd] = await Promise.all([
    getFactByBranch(fromIso, toExclIso),
    getPlanTargets(year),
    getWorkingDayProgress(year, todayStr),
  ]);

  if (!wd) {
    console.warn(`[planSummary] working_calendar пуст для ${year} года — plan_percent_pace будет null`);
  }

  const russia = computeMetrics('Россия', russiaTotal, targets.company, wd);

  const branchNames = new Set([...byBranch.keys(), ...targets.branch.keys()]);
  const branches = [...branchNames].map(name => {
    const metrics = computeMetrics(name, byBranch.get(name) ?? 0, targets.branch.get(name) ?? null, wd);

    const prefix = `${name}:`;
    const categories = new Set(
      [...byDept.keys(), ...targets.department.keys()]
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length)),
    );
    if (categories.size > 0) {
      metrics.departments = [...categories]
        .sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b))
        .map(cat => {
          const key = `${prefix}${cat}`;
          return computeMetrics(cat, byDept.get(key) ?? 0, targets.department.get(key) ?? null, wd);
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
