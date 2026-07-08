import { ycAnalyticsDb } from '@/lib/db/clients';
import type { Metric } from './types';
import { resolveAutoColor } from './entity-colors';

let _cache: Metric[] | null = null;
let _cacheAt = 0;
const TTL = 5 * 60 * 1000;

export function invalidateMetricsCache() {
  _cache = null;
  _cacheAt = 0;
}

export async function loadMetrics(): Promise<Metric[]> {
  if (_cache && Date.now() - _cacheAt < TTL) return _cache;

  const db = ycAnalyticsDb();

  // Цвета метрик: правило категории + точечные переопределения (metric_colors)
  let catColors = new Map<string, string>();
  let metricColors = new Map<string, string>();
  try {
    const colRes = await db.query<{ scope: string; key: string; color: string }>(
      'SELECT scope, key, color FROM metric_colors',
    );
    catColors = new Map(colRes.rows.filter(r => r.scope === 'category').map(r => [r.key, r.color]));
    metricColors = new Map(colRes.rows.filter(r => r.scope === 'metric').map(r => [r.key, r.color]));
  } catch { /* таблицы может не быть до миграции 043 */ }
  const res = await db.query<{
    id: string; name_ru: string; name_short_ru: string | null;
    description: string | null; calc_ok: boolean; fill_ok: boolean;
    metric_type: string; data_type: string; formula: string | null;
    dependencies: string[] | null; decimal_places: number;
    aggregation_fn: string; category: string | null;
    sort_order: number; is_core: boolean; is_hidden_in_ui: boolean;
    is_active: boolean; is_test: boolean;
    source: string; agg_fn: string | null; agg_field: string | null;
    date_field: string | null; filters: string | null; tags: string[] | null;
    is_collect_ok: boolean; is_calc_ok: boolean;
  }>(`
    SELECT id, name_ru, name_short_ru, description, calc_ok, fill_ok,
           metric_type, data_type, formula,
           dependencies, decimal_places, aggregation_fn, category,
           sort_order, is_core, is_hidden_in_ui, is_active,
           COALESCE(is_test, false) AS is_test,
           COALESCE(source, 'deals') AS source,
           agg_fn, agg_field, date_field,
           filters::text AS filters,
           tags,
           COALESCE(is_collect_ok, false) AS is_collect_ok,
           COALESCE(is_calc_ok, false) AS is_calc_ok
    FROM metrics
    WHERE is_active = true OR is_hidden_in_ui = false
    ORDER BY sort_order, name_ru
  `);

  _cache = res.rows.map(r => ({
    id: r.id,
    nameRu: r.name_ru,
    nameShortRu: r.name_short_ru,
    description: r.description,
    calcOk: r.calc_ok ?? false,
    fillOk: r.fill_ok ?? false,
    metricType: r.metric_type as Metric['metricType'],
    dataType: r.data_type as Metric['dataType'],
    formula: r.formula,
    dependencies: r.dependencies ?? [],
    decimalPlaces: r.decimal_places,
    aggregationFn: r.aggregation_fn as Metric['aggregationFn'],
    category: r.category,
    sortOrder: r.sort_order,
    isCore: r.is_core,
    isActive: r.is_active,
    isHiddenInUi: r.is_hidden_in_ui,
    isTest: r.is_test,
    source: (r.source ?? 'deals') as Metric['source'],
    aggFn: (r.agg_fn ?? null) as Metric['aggFn'],
    aggField: r.agg_field ?? null,
    dateField: r.date_field ?? null,
    filters: r.filters ? JSON.parse(r.filters) : [],
    tags: r.tags ?? [],
    isCollectOk: r.is_collect_ok,
    isCalcOk: r.is_calc_ok,
    // Приоритет: ручное переопределение по метрике > по категории > автоцвет по
    // сущности (lib/metrics/entity-colors.ts, задача 6а, п.10 спеки 2026-07-08).
    // Автоцвет — код, не БД: metric_colors хранит ТОЛЬКО ручные переопределения.
    color:
      metricColors.get(r.id) ??
      (r.category ? catColors.get(r.category) : null) ??
      resolveAutoColor({ id: r.id, category: r.category, nameRu: r.name_ru }),
  }));
  _cacheAt = Date.now();
  return _cache;
}

export function invalidateMetricColors() {
  invalidateMetricsCache();
}

export function resolveMetricIds(ids: string[], all: Metric[]): Metric[] {
  const map = new Map(all.map(m => [m.id, m]));

  if (ids.includes('all_core')) {
    return all.filter(m => m.isCore && !m.isHiddenInUi && m.isActive);
  }

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
