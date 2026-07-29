import type { WidgetMetricsBlob, WidgetScopeLeaf } from '@/lib/jobs/widgetMetrics';
import { normalizeMetricIds, type WidgetConfig } from './config';

// Срез матрицы → отображаемые значения. Переработка 17.07: план/факт схлопнуты в
// completion-% (одно кольцо), абсолюты отдельно; каждая позиция несёт main-значение
// (то, что в центре кольца) + fact/plan для мелкой подписи.

export interface WidgetSliceItem {
  id: string;
  /** Главное число: % для completion/CR, ₽ для money. null = нет данных (план не задан). */
  value: number | null;
  kind: 'completion' | 'money' | 'percent';
  /** Для подписи «факт из плана» у completion и «из плана» у money-года. */
  fact?: number;
  plan?: number | null;
}

export interface WidgetSlice {
  updated_at: string;
  scope_name: string;
  period_preset: string;
  viz_kind: string;
  colors: WidgetConfig['colors'];
  values: WidgetSliceItem[];
}

function leafFor(blob: WidgetMetricsBlob, config: WidgetConfig): WidgetScopeLeaf | null {
  const block = blob.periods[config.period_preset];
  if (!block) return null;
  if (config.scope_kind === 'russia') return block.russia;
  if (config.scope_kind === 'branch') return config.scope_id ? block.branches[config.scope_id] ?? null : null;
  return config.scope_id ? block.departments[config.scope_id] ?? null : null;
}

function pct(fact: number, plan: number | null): number | null {
  if (plan === null || plan <= 0) return null;
  return Math.round((fact / plan) * 1000) / 10;
}

function itemFor(id: string, v: WidgetScopeLeaf['values']): WidgetSliceItem | null {
  switch (id) {
    case 'sales_completion':
      return { id, kind: 'completion', value: pct(v.fact_sales, v.plan_sales), fact: v.fact_sales, plan: v.plan_sales };
    case 'shipments_completion':
      return { id, kind: 'completion', value: pct(v.fact_shipments, v.plan_shipments), fact: v.fact_shipments, plan: v.plan_shipments };
    case 'fact_sales':
      return { id, kind: 'money', value: v.fact_sales, fact: v.fact_sales, plan: v.plan_sales };
    case 'fact_shipments':
      return { id, kind: 'money', value: v.fact_shipments, fact: v.fact_shipments, plan: v.plan_shipments };
    case 'cr_sale':
      return { id, kind: 'percent', value: v.cr_sale };
    case 'cr_shipment':
      return { id, kind: 'percent', value: v.cr_shipment };
    default:
      return null;
  }
}

/** Срез для конфига: null, если периода/разреза нет в блобе (протух/отдел исчез). */
export function sliceForConfig(blob: WidgetMetricsBlob, config: WidgetConfig): WidgetSlice | null {
  const leaf = leafFor(blob, config);
  if (!leaf) return null;
  // normalizeMetricIds — конфиги из БД могли быть сохранены до переработки (старые id).
  const ids = normalizeMetricIds(config.metrics);
  const values = ids.map(id => itemFor(id, leaf.values)).filter((x): x is WidgetSliceItem => x !== null);
  return {
    updated_at: blob.updated_at,
    scope_name: leaf.name,
    period_preset: config.period_preset,
    viz_kind: config.viz_kind,
    colors: config.colors,
    values,
  };
}

export interface WidgetScopeOption { id: string; name: string; branch?: string }
export interface WidgetCatalog {
  updated_at: string | null;
  branches: WidgetScopeOption[];
  departments: WidgetScopeOption[];
}

/** Каталог доступных разрезов из блоба — для селектов конструктора. */
export function buildCatalog(blob: WidgetMetricsBlob | null): WidgetCatalog {
  if (!blob) return { updated_at: null, branches: [], departments: [] };
  const block = blob.periods.this_year ?? Object.values(blob.periods)[0];
  const branches = Object.entries(block?.branches ?? {}).map(([id, leaf]) => ({ id, name: leaf.name }));
  const departments = Object.entries(block?.departments ?? {})
    .map(([id, leaf]) => ({ id, name: leaf.name, branch: leaf.branch }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  branches.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { updated_at: blob.updated_at, branches, departments };
}
