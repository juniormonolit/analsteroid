export type MetricType = 'collected' | 'calculated' | 'external';
export type DataType = 'int' | 'decimal' | 'money' | 'percent' | 'months';
export type AggregationFn = 'sum' | 'avg' | 'none';
export type AggFn = 'count_distinct' | 'sum' | 'avg' | 'count_all';
export type MetricSource = 'deals' | 'deal_events';
export type DealScope = 'primary' | 'repeat' | 'all';
export type ClientType = 'all' | 'b2c' | 'b2b';
export type Grouping = 'none' | 'team' | 'branch' | 'total';
export type ProductGroupMode = 'kc' | 'by_max';
export type ComparisonDisplay = 'full' | 'partial' | 'compact' | 'current';
export type AccountType = 'managers' | 'logists' | 'all';
// Границы таблицы отчёта (п.4 правок 09.07, «Вид» → «Границы»): grid — полная сетка
// (дефолт, горизонтальные + вертикальные между колонками метрик), horizontal — только
// горизонтальные (было единственным поведением до этой правки), none — без границ.
export type BorderMode = 'grid' | 'horizontal' | 'none';

export interface MetricFilter {
  field: string;
  // gt_field: column-vs-column comparison — value is another column name (e.g. lost_at > sold_at)
  op: 'eq' | 'neq' | 'in' | 'not_in' | 'is_null' | 'is_not_null' | 'gt_field';
  value: string | number | string[] | number[];
}

export interface Metric {
  id: string;
  nameRu: string;
  nameShortRu: string | null;
  description?: string | null;
  calcOk: boolean;
  fillOk: boolean;
  metricType: MetricType;
  dataType: DataType;
  formula: string | null;
  dependencies: string[];
  decimalPlaces: number;
  aggregationFn: AggregationFn;
  category: string | null;
  sortOrder: number;
  isCore: boolean;
  isActive: boolean;
  isHiddenInUi: boolean;
  isTest: boolean;
  // Constructor fields
  source: MetricSource;
  aggFn: AggFn | null;
  aggField: string | null;
  dateField: string | null;
  filters: MetricFilter[];
  tags: string[];
  isCollectOk: boolean;
  isCalcOk: boolean;
  // Цвет показателя (бейдж заголовка колонки): override по метрике > правило категории
  color?: string | null;
}

export interface ReportRow {
  dimensionId: string;
  dimensionName: string;
  dimensionSubtitle?: string;
  teamId: string | null;
  teamName: string | null;
  branchName?: string | null;
  metrics: Record<string, number | null>;
}

// Итого-агрегат метрики: тот же состав полей, что и per-row deltas (current/comparison/
// delta/deltaPct) — правка 09.07 (баг «Итого теряет прошлый период в сравнении», см.
// app/api/reports/run/route.ts).
export interface TotalsMetricValue {
  current: number | null;
  comparison: number | null;
  delta: number | null;
  deltaPct: number | null;
}

export interface ReportResult {
  rows: ReportRow[];
  totals: Record<string, TotalsMetricValue> | null;
  meta: {
    period: { from: string; to: string };
    comparisonPeriod: { from: string; to: string };
    cacheHit: boolean;
    durationMs: number;
  };
}
