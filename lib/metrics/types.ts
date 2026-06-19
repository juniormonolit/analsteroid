export type MetricType = 'collected' | 'calculated' | 'external';
export type DataType = 'int' | 'decimal' | 'money' | 'percent' | 'months';
export type AggregationFn = 'sum' | 'avg' | 'none';
export type DealScope = 'primary' | 'repeat' | 'all';
export type Grouping = 'none' | 'team' | 'total';
export type ProductGroupMode = 'kc' | 'by_max';
export type ComparisonDisplay = 'full' | 'current';

export interface Metric {
  id: string;
  nameRu: string;
  nameShortRu: string | null;
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
}

export interface ReportRow {
  dimensionId: string;       // manager_id or product_group_id (string)
  dimensionName: string;
  teamId: string | null;
  teamName: string | null;
  metrics: Record<string, number | null>;
}

export interface ReportResult {
  rows: ReportRow[];
  totals: Record<string, number | null> | null;
  meta: {
    period: { from: string; to: string };
    comparisonPeriod: { from: string; to: string };
    cacheHit: boolean;
    durationMs: number;
  };
}
