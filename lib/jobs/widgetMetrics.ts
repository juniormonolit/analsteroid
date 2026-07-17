import { systemDb } from '@/lib/db/clients';
import { getRedis } from '@/lib/cache/redis';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { computePeriodPlanByLogin } from '@/lib/plans/dailyPlan';
import { WIDGET_PERIOD_PRESETS, resolveWidgetPeriod, type WidgetPeriodPreset } from '@/lib/widget/periods';
import type { WidgetMetricValues } from '@/lib/widget/metrics';
import { formatInTimeZone } from 'date-fns-tz';

const TZ = 'Europe/Moscow';
const REDIS_KEY = 'widget:metrics';
const REDIS_TTL_SEC = 30 * 60; // джоба крутится раз в 10 мин — запас x3

// branch из org_resolved_hierarchy → метки филиалов конструктора (как в plan_targets_year).
// Екатеринбург и прочие остаются как есть (собственная строка, свой scope_id).
const BRANCH_LABELS: Record<string, string> = {
  'СПб': 'СПБ',
  'Москва/МО': 'МСК',
  'Краснодар': 'КРД',
};
function normBranch(b: string | null | undefined): string {
  if (!b) return 'СПБ';
  return BRANCH_LABELS[b] ?? b;
}

export interface WidgetScopeLeaf {
  name: string;
  branch?: string; // для departments — к какому филиалу относится
  values: WidgetMetricValues;
}
export interface WidgetPeriodBlock {
  russia: WidgetScopeLeaf;
  branches: Record<string, WidgetScopeLeaf>;     // ключ — 'СПБ'|'МСК'|'КРД'|...
  departments: Record<string, WidgetScopeLeaf>;  // ключ — department_id
}
export interface WidgetMetricsBlob {
  updated_at: string;
  periods: Record<WidgetPeriodPreset, WidgetPeriodBlock>;
}

// Аккумулятор до финализации (счётчики → отношения на выходе).
interface Acc {
  name: string;
  branch?: string;
  factSales: number;
  factShipments: number;
  planSales: number;
  planShipments: number;
  planPresent: boolean;
  primSalesCnt: number;
  primShipCnt: number;
  primDealsCnt: number;
}
function mkAcc(name: string, branch?: string): Acc {
  return { name, branch, factSales: 0, factShipments: 0, planSales: 0, planShipments: 0, planPresent: false, primSalesCnt: 0, primShipCnt: 0, primDealsCnt: 0 };
}
function finalize(a: Acc): WidgetScopeLeaf {
  const cr = (num: number, denom: number): number | null =>
    denom > 0 ? Math.round((num / denom) * 1000) / 10 : null;
  return {
    name: a.name,
    branch: a.branch,
    values: {
      plan_sales: a.planPresent ? Math.round(a.planSales) : null,
      fact_sales: Math.round(a.factSales),
      plan_shipments: a.planPresent ? Math.round(a.planShipments) : null,
      fact_shipments: Math.round(a.factShipments),
      cr_sale: cr(a.primSalesCnt, a.primDealsCnt),
      cr_shipment: cr(a.primShipCnt, a.primDealsCnt),
    },
  };
}

function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

async function loadLoginToDept(): Promise<Map<string, { deptId: string | null; deptName: string | null; branch: string }>> {
  const res = await systemDb().query<{ short_login: string; department_id: string | null; department_name: string | null; branch: string | null }>(
    `SELECT short_login, department_id, department_name, branch
       FROM org_resolved_hierarchy WHERE is_active = true AND short_login IS NOT NULL`,
  );
  const map = new Map<string, { deptId: string | null; deptName: string | null; branch: string }>();
  for (const r of res.rows) {
    map.set(r.short_login, { deptId: r.department_id, deptName: r.department_name, branch: normBranch(r.branch) });
  }
  return map;
}

async function computePeriod(preset: WidgetPeriodPreset, loginToDept: Map<string, { deptId: string | null; deptName: string | null; branch: string }>): Promise<WidgetPeriodBlock> {
  const { range, fromStr, todayStr } = resolveWidgetPeriod(preset);

  const [rows, plan] = await Promise.all([
    fetchByManagers({ period: range, dealScope: 'all', clientType: 'all', accountType: 'all' }),
    computePeriodPlanByLogin(fromStr, todayStr, todayStr),
  ]);

  const russia = mkAcc('Россия');
  const branches = new Map<string, Acc>();
  const departments = new Map<string, Acc>();

  const branchAcc = (label: string) => {
    let a = branches.get(label);
    if (!a) { a = mkAcc(label); branches.set(label, a); }
    return a;
  };
  const deptAcc = (id: string, name: string, branch: string) => {
    let a = departments.get(id);
    if (!a) { a = mkAcc(name, branch); departments.set(id, a); }
    return a;
  };

  // Факт + счётчики — из строк по менеджерам.
  for (const row of rows) {
    const m = row.metrics;
    const factSales = num(m.primary_sales_amount) + num(m.repeat_sales_amount);
    const factShipments = num(m.primary_shipments_amount) + num(m.repeat_shipments_amount);
    const primSalesCnt = num(m.primary_sales_count);
    const primShipCnt = num(m.primary_shipments_count);
    const primDealsCnt = num(m.primary_deals_count);
    const branch = normBranch(row.branchName);

    for (const a of [russia, branchAcc(branch), ...(row.teamId ? [deptAcc(row.teamId, row.teamName ?? row.teamId, branch)] : [])]) {
      a.factSales += factSales;
      a.factShipments += factShipments;
      a.primSalesCnt += primSalesCnt;
      a.primShipCnt += primShipCnt;
      a.primDealsCnt += primDealsCnt;
    }
  }

  // План — из manager_plans по логину, раскладываем в отдел/филиал/Россию по оргструктуре
  // (включая менеджеров с планом, но без сделок в периоде — их нет в rows).
  for (const [login, p] of plan.byLogin) {
    const info = loginToDept.get(login);
    const branch = info ? info.branch : 'СПБ';
    const targets: Acc[] = [russia, branchAcc(branch)];
    if (info?.deptId) targets.push(deptAcc(info.deptId, info.deptName ?? info.deptId, branch));
    for (const a of targets) {
      a.planSales += p.planSales;
      a.planShipments += p.planShipments;
      a.planPresent = true;
    }
  }

  return {
    russia: finalize(russia),
    branches: Object.fromEntries([...branches].map(([k, a]) => [k, finalize(a)])),
    departments: Object.fromEntries([...departments].map(([k, a]) => [k, finalize(a)])),
  };
}

export async function computeAndCacheWidgetMetrics(): Promise<void> {
  const client = getRedis();
  if (!client) {
    console.warn('[widgetMetrics] Redis не настроен, пропускаю расчёт');
    return;
  }

  const loginToDept = await loadLoginToDept();

  const periods = {} as Record<WidgetPeriodPreset, WidgetPeriodBlock>;
  for (const preset of WIDGET_PERIOD_PRESETS) {
    periods[preset] = await computePeriod(preset, loginToDept);
  }

  const blob: WidgetMetricsBlob = {
    updated_at: formatInTimeZone(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    periods,
  };
  await client.set(REDIS_KEY, JSON.stringify(blob), 'EX', REDIS_TTL_SEC);
}

export async function getCachedWidgetMetrics(): Promise<WidgetMetricsBlob | null> {
  const client = getRedis();
  if (!client) return null;
  const raw = await client.get(REDIS_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as WidgetMetricsBlob;
}
