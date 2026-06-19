import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadMetrics, resolveMetricIds, withDependencies } from '@/lib/metrics/catalog';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { fetchByProductGroups } from '@/features/reports/engine/byProductGroups';
import { computeCalculated, computeTotals, computeDelta } from '@/features/reports/engine/calculated';
import { applyGrouping } from '@/features/reports/engine/grouping';
import type { DealScope, Grouping, ReportRow, ProductGroupMode } from '@/lib/metrics/types';

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
    departmentIds,
  };
  const compOpts = {
    period: { from: new Date(comparisonPeriod.from), to: new Date(comparisonPeriod.to) },
    dealScope,
    departmentIds,
  };

  let currentRows: ReportRow[] = [];
  let compRows: ReportRow[] = [];

  if (reportSlug === 'by-managers') {
    [currentRows, compRows] = await Promise.all([
      fetchByManagers(opts),
      fetchByManagers(compOpts),
    ]);
  } else if (reportSlug === 'by-product-groups') {
    [currentRows, compRows] = await Promise.all([
      fetchByProductGroups({ period: opts.period, dealScope, productGroupMode }),
      fetchByProductGroups({ period: compOpts.period, dealScope, productGroupMode }),
    ]);
  }

  // Add calculated metrics to each row
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
