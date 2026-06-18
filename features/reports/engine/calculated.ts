import type { Metric } from '@/lib/metrics/types';

/** Compute calculated metrics (CR, conversions) from collected raw values */
export function computeCalculated(
  rawMetrics: Record<string, number | null>,
  calculatedMetrics: Metric[]
): Record<string, number | null> {
  const result = { ...rawMetrics };

  for (const m of calculatedMetrics) {
    if (m.metricType !== 'calculated' || !m.formula) continue;
    try {
      const value = evalFormula(m.formula, result);
      result[m.id] = value;
    } catch {
      result[m.id] = null;
    }
  }
  return result;
}

function evalFormula(formula: string, values: Record<string, number | null>): number | null {
  // Replace metric ids with their values
  // Formula syntax: "numerator / denominator * 100" where terms are metric ids or numbers
  let expr = formula;
  const ids = Object.keys(values).sort((a, b) => b.length - a.length); // longest first to avoid partial replace
  for (const id of ids) {
    const v = values[id];
    expr = expr.replaceAll(id, v === null ? 'null' : String(v));
  }
  // Safety: only allow numbers, operators, spaces, null
  if (!/^[\d\s.+\-*/()null]+$/.test(expr)) return null;
  // null propagation
  if (expr.includes('null')) return null;
  // eslint-disable-next-line no-new-func
  const result = Function(`"use strict"; return (${expr})`)() as number;
  if (!isFinite(result) || isNaN(result)) return null;
  return result;
}

/** Compute totals row: sum collected, recompute calculated from sums */
export function computeTotals(
  rows: Array<{ metrics: Record<string, number | null> }>,
  allMetrics: Metric[]
): Record<string, number | null> {
  const sums: Record<string, number | null> = {};
  const collectedIds = allMetrics
    .filter(m => m.metricType === 'collected')
    .map(m => m.id);

  // Sum collected metrics
  for (const id of collectedIds) {
    sums[id] = rows.reduce((acc, r) => {
      const v = r.metrics[id];
      return acc === null && v === null ? null : (acc ?? 0) + (v ?? 0);
    }, null as number | null);
  }

  // Recompute calculated from summed values
  const calculated = allMetrics.filter(m => m.metricType === 'calculated');
  return computeCalculated(sums, calculated);
}

/** Compute delta between current and comparison */
export function computeDelta(
  current: number | null,
  comparison: number | null
): { delta: number | null; deltaPct: number | null } {
  if (current === null || comparison === null) return { delta: null, deltaPct: null };
  const delta = current - comparison;
  const deltaPct = comparison === 0
    ? (current === 0 ? 0 : current > 0 ? Infinity : -Infinity)
    : (delta / comparison) * 100;
  return { delta, deltaPct };
}
