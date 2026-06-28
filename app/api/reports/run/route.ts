import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadMetrics, resolveMetricIds, withDependencies } from '@/lib/metrics/catalog';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { fetchByProductGroups } from '@/features/reports/engine/byProductGroups';
import { computeCalculated, computeTotals, computeDelta } from '@/features/reports/engine/calculated';
import { applyGrouping } from '@/features/reports/engine/grouping';
import { systemDb } from '@/lib/db/clients';
import type { DealScope, ClientType, Grouping, ReportRow, ProductGroupMode } from '@/lib/metrics/types';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const {
    reportSlug = 'by-managers',
    period,
    comparisonPeriod,
    metricIds = ['all_core'],
    dealScope = 'primary' as DealScope,
    clientType = 'all' as ClientType,
    grouping = 'none' as Grouping,
    departmentIds,
    productGroupMode = 'kc' as ProductGroupMode,
  } = body;

  const start = Date.now();

  const allMetrics = await loadMetrics();
  const requested = resolveMetricIds(metricIds, allMetrics);
  const withDeps = withDependencies(requested, allMetrics);
  const calculatedMetrics = withDeps.filter(m => m.metricType === 'calculated');

  const opts = {
    period: { from: new Date(period.from), to: new Date(period.to) },
    dealScope,
    clientType,
    departmentIds,
  };
  const compOpts = {
    period: { from: new Date(comparisonPeriod.from), to: new Date(comparisonPeriod.to) },
    dealScope,
    clientType,
    departmentIds,
  };

  let currentRows: ReportRow[] = [];
  let compRows: ReportRow[] = [];

  if (reportSlug === 'by-managers') {
    [currentRows, compRows] = await Promise.all([
      fetchByManagers({ ...opts, productGroupMode }),
      fetchByManagers({ ...compOpts, productGroupMode }),
    ]);
  } else if (reportSlug === 'by-product-groups') {
    [currentRows, compRows] = await Promise.all([
      fetchByProductGroups({ period: opts.period, dealScope, clientType, productGroupMode }),
      fetchByProductGroups({ period: compOpts.period, dealScope, clientType, productGroupMode }),
    ]);
  }

  // Fetch plan data for external metrics
  const planMetricIds = ['plan_sales_month', 'plan_shipments_month', 'plan_sales_today', 'plan_shipments_today'];
  const hasAnyPlanMetric = withDeps.some(m => planMetricIds.includes(m.id));

  if (hasAnyPlanMetric) {
    const periodStart = new Date(period.from);
    const periodEnd = new Date(period.to);

    const months: string[] = [];
    const cur = new Date(periodStart.getFullYear(), periodStart.getMonth(), 1);
    const end = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);
    while (cur <= end) {
      months.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
      cur.setMonth(cur.getMonth() + 1);
    }

    const sysDb = systemDb();

    const plansRes = await sysDb.query<{ manager_login: string; month: string; plan_shipments: string; plan_n: string }>(
      `SELECT manager_login, to_char(month, 'YYYY-MM') as month, plan_shipments, plan_n
       FROM manager_plans WHERE to_char(month, 'YYYY-MM') = ANY($1)`,
      [months]
    );

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const currentMonthStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    let workingDaysInMonth = 22;
    let workingDayOrdinal = 15;

    try {
      const wcRes = await sysDb.query<{ total_working: string; days_passed: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE is_working AND to_char(date, 'YYYY-MM') = $1) AS total_working,
           COUNT(*) FILTER (WHERE is_working AND to_char(date, 'YYYY-MM') = $1 AND date <= $2::date) AS days_passed
         FROM working_calendar
         WHERE to_char(date, 'YYYY-MM') = $1`,
        [currentMonthStr, todayStr]
      );
      if (wcRes.rows[0]?.total_working) {
        workingDaysInMonth = parseInt(wcRes.rows[0].total_working) || 22;
        workingDayOrdinal = parseInt(wcRes.rows[0].days_passed) || 1;
      }
    } catch { /* table may not exist yet */ }

    const planByLogin = new Map<string, { plan_shipments: number; plan_n: number }>();
    for (const row of plansRes.rows) {
      const existing = planByLogin.get(row.manager_login);
      const ps = parseFloat(row.plan_shipments);
      const pn = parseFloat(row.plan_n);
      if (existing) {
        existing.plan_shipments += ps;
      } else {
        planByLogin.set(row.manager_login, { plan_shipments: ps, plan_n: pn });
      }
    }

    const enrichRow = (row: ReportRow): ReportRow => {
      const login = row.dimensionSubtitle;
      const plan = login ? planByLogin.get(login) : undefined;
      if (!plan) return row;
      const planSalesMonth = plan.plan_shipments / plan.plan_n;
      const planShipmentsMonth = plan.plan_shipments;
      const planSalesToday = (planSalesMonth / workingDaysInMonth) * workingDayOrdinal;
      const planShipmentsToday = (planShipmentsMonth / workingDaysInMonth) * workingDayOrdinal;
      return {
        ...row,
        metrics: {
          ...row.metrics,
          plan_sales_month: planSalesMonth,
          plan_shipments_month: planShipmentsMonth,
          plan_sales_today: planSalesToday,
          plan_shipments_today: planShipmentsToday,
        }
      };
    };
    currentRows = currentRows.map(enrichRow);
    compRows = compRows.map(enrichRow);
  }

  // Add calculated metrics to each row (after plan enrichment so plan-dependent metrics work)
  const enrich = (row: ReportRow): ReportRow => ({
    ...row,
    metrics: computeCalculated(row.metrics, calculatedMetrics),
  });
  currentRows = currentRows.map(enrich);
  compRows = compRows.map(enrich);

  // Merge current + comparison by dimensionId
  const compMap = new Map(compRows.map(r => [r.dimensionId, r]));
  const mergedRows = currentRows.map(row => {
    const comp = compMap.get(row.dimensionId);
    const metricIds = Object.keys(row.metrics);
    const deltas: Record<string, { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null }> = {};
    for (const id of metricIds) {
      deltas[id] = {
        current: row.metrics[id] ?? null,
        comparison: comp?.metrics[id] ?? null,
        ...computeDelta(row.metrics[id] ?? null, comp?.metrics[id] ?? null),
      };
    }
    return { ...row, deltas };
  });

  // Apply grouping
  const grouped = applyGrouping(currentRows, grouping, allMetrics);

  // Totals
  const totalsRaw = computeTotals(currentRows, allMetrics);
  const totals = computeCalculated(totalsRaw, calculatedMetrics);

  return NextResponse.json({
    rows: mergedRows,
    grouped,
    totals,
    metrics: requested.filter(m => !m.isHiddenInUi),
    meta: {
      period: { from: period.from, to: period.to },
      comparisonPeriod: { from: comparisonPeriod.from, to: comparisonPeriod.to },
      cacheHit: false,
      durationMs: Date.now() - start,
    },
  });
}
