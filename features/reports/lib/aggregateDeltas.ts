import { computeCalculated } from '@/features/reports/engine/calculated';
import type { Metric } from '@/lib/metrics/types';

export type DeltaCell = { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null };
export type Deltas = Record<string, DeltaCell>;

// Честная агрегация набора строк: collected/external суммируются, calculated (конверсии,
// средние чеки, % плана) пересчитываются по своей формуле от СУММ — отдельно для
// текущего и сравнительного периодов. Просто складывать проценты нельзя.
// Общая для строк отдела/филиала/пользовательских групп (SalesReportPage) и для
// «Итого» по строкам, оставшимся после фильтров колонок (ReportTable).
export function aggregateGroupDeltas(members: { deltas: Deltas }[], metrics: Metric[]): Deltas {
  const ids = new Set<string>();
  for (const r of members) for (const id of Object.keys(r.deltas)) ids.add(id);
  const byId = new Map(metrics.map(m => [m.id, m]));

  const sumsCur: Record<string, number | null> = {};
  const sumsCmp: Record<string, number | null> = {};
  for (const id of ids) {
    const m = byId.get(id);
    if (m?.metricType === 'calculated') continue;
    // Несуммируемые external (медианы, клиентские значения, aggregation_fn='none')
    // в строке группы честно пусты: сумма медиан 12 команд — не медиана филиала
    // (инцидент 03.09: СПб показывал 164,7 «средних товарных групп на клиента»).
    if (m?.metricType === 'external' && m.aggregationFn !== 'sum') continue;
    let cur: number | null = null, cmp: number | null = null;
    for (const r of members) {
      const d = r.deltas[id];
      if (!d) continue;
      if (d.current !== null) cur = (cur ?? 0) + d.current;
      if (d.comparison !== null) cmp = (cmp ?? 0) + d.comparison;
    }
    sumsCur[id] = cur;
    sumsCmp[id] = cmp;
  }

  const calc = metrics.filter(m => m.metricType === 'calculated' && ids.has(m.id));
  const cur = computeCalculated(sumsCur, calc);
  const cmp = computeCalculated(sumsCmp, calc);

  const deltas: Deltas = {};
  for (const id of ids) {
    const c = cur[id] ?? null, p = cmp[id] ?? null;
    const delta = c !== null && p !== null ? c - p : null;
    const deltaPct = delta === null || p === null || p === 0 ? null : (delta / p) * 100;
    deltas[id] = { current: c, comparison: p, delta, deltaPct };
  }
  return deltas;
}
