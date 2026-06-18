import { analyticsDb } from '@/lib/db/clients';
import type { Metric } from './types';

let _cache: Metric[] | null = null;
let _cacheAt = 0;
const TTL = 5 * 60 * 1000;

export async function loadMetrics(): Promise<Metric[]> {
  if (_cache && Date.now() - _cacheAt < TTL) return _cache;

  const db = analyticsDb();
  const res = await db.query<{
    id: string; name_ru: string; name_short_ru: string | null;
    metric_type: string; data_type: string; formula: string | null;
    dependencies: string[] | null; decimal_places: number;
    aggregation_fn: string; category: string | null;
    sort_order: number; is_core: boolean; is_hidden_in_ui: boolean;
  }>(`
    SELECT id, name_ru, name_short_ru, metric_type, data_type, formula,
           dependencies, decimal_places, aggregation_fn, category,
           sort_order, is_core, is_hidden_in_ui
    FROM metrics
    WHERE is_active = true
    ORDER BY sort_order, name_ru
  `);

  _cache = res.rows.map(r => ({
    id: r.id,
    nameRu: r.name_ru,
    nameShortRu: r.name_short_ru,
    metricType: r.metric_type as Metric['metricType'],
    dataType: r.data_type as Metric['dataType'],
    formula: r.formula,
    dependencies: r.dependencies ?? [],
    decimalPlaces: r.decimal_places,
    aggregationFn: r.aggregation_fn as Metric['aggregationFn'],
    category: r.category,
    sortOrder: r.sort_order,
    isCore: r.is_core,
    isActive: true,
    isHiddenInUi: r.is_hidden_in_ui,
  }));
  _cacheAt = Date.now();
  return _cache;
}

export function resolveMetricIds(ids: string[], all: Metric[]): Metric[] {
  if (ids.includes('all_core')) {
    return all.filter(m => m.isCore && !m.isHiddenInUi);
  }
  const map = new Map(all.map(m => [m.id, m]));
  return ids.map(id => map.get(id)).filter(Boolean) as Metric[];
}

/** Expand calculated metrics to include all transitive dependencies */
export function withDependencies(metrics: Metric[], all: Metric[]): Metric[] {
  const map = new Map(all.map(m => [m.id, m]));
  const result = new Map<string, Metric>();
  function add(m: Metric) {
    if (result.has(m.id)) return;
    result.set(m.id, m);
    for (const dep of m.dependencies) {
      const d = map.get(dep);
      if (d) add(d);
    }
  }
  metrics.forEach(add);
  return Array.from(result.values());
}
