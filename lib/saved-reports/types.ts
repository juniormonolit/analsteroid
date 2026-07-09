import type { DealScope, ClientType, Grouping, ProductGroupMode, ComparisonDisplay, AccountType } from '@/lib/metrics/types';

export type PeriodAnchor = 'current' | 'previous';
export type PeriodUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type ComparisonMode = 'analogous' | 'previous_tail';
export type PeriodMode = 'relative' | 'fixed';

export interface RelativePeriod {
  anchor: PeriodAnchor;
  unit: PeriodUnit;
}

export interface HighlightThreshold {
  value: number;
  color: string;
}

export interface MetricHighlightConfig {
  enabled: boolean;
  thresholds: HighlightThreshold[]; // N-1 thresholds for N buckets
  aboveColor: string;                // color for values above last threshold
}

export interface SavedReport {
  id: string;
  userLogin: string;
  reportSlug: string;
  name: string;
  metricIds: string[];
  dealScope: DealScope;
  clientType: ClientType;
  grouping: Grouping;
  comparisonDisplay: ComparisonDisplay;
  productGroupMode: ProductGroupMode;
  departmentIds: string[];
  metricHighlights: Record<string, MetricHighlightConfig>;
  // Per-metric display mode overrides; null entry = use global comparisonDisplay
  metricDisplayModes: Record<string, ComparisonDisplay>;
  // Threshold (%) below which delta is considered neutral (~); default 5
  comparisonThreshold: number;
  // Per-metric pinned rows
  pinnedMetricIds?: string[];
  // Per-metric decimal place overrides
  metricDecimalOverrides?: Record<string, number>;
  // Per-metric comparison threshold overrides
  metricThresholdOverrides?: Record<string, number>;
  // Metrics rendered with accent (bold + tinted column background)
  accentedMetricIds?: string[];
  // Metrics rendered with an in-cell horizontal bar (proportional to column max)
  barMetricIds?: string[];
  // Metrics rendered with a per-column heat map (red→green gradient min→max)
  heatmapMetricIds?: string[];
  // Heatmap metrics where less = better (gradient inverted: min = green)
  heatmapInvertedIds?: string[];
  // Colorize metric column headers by category color rules. undefined = true.
  colorizeMetrics?: boolean;
  // «Зебра» (правка владельца 09.07): лёгкая полосатость чётных строк ReportTable.
  // undefined/null = false (текущее поведение, вариант C без зебры).
  zebra?: boolean;
  // Report-wide accent color (hex). Drives accent/bars/heatmap. null/undefined = app default.
  themeAccent?: string | null;
  // Report-wide horizontal alignment of numeric cells. undefined = 'center' (default).
  numberAlign?: 'left' | 'center' | 'right';
  // Account-type filter for the manager list (by bitrix_login prefix). undefined = 'managers'.
  accountType?: AccountType;
  // Drilldown: reuse the main report's metrics for the per-product-group view. undefined = true.
  drilldownDuplicateMetrics?: boolean;
  // Drilldown: independent metric set when not duplicating the main report.
  drilldownMetricIds?: string[];
  // Drilldown: which deal fields show as columns in the expanded deal list. undefined = all.
  dealFields?: string[];
  // Drilldown: group deals by product group / manager (true, default) or flat list (false).
  drilldownGrouped?: boolean;
  // Marketing (by-sources): main dimension of the report. undefined = 'brand'.
  sourceDimension?: string;
  // Marketing: dimension used in the drilldown mini-report. undefined = 'contact_type'.
  drilldownDimension?: string;
  // «Смекалочная»: общий отчёт — виден всем, пересохранять может только админ.
  isShared?: boolean;
  // Пункт 3б спеки: раздел общей витрины (одна механика, два раздела в сайдбаре).
  // null/undefined = личный отчёт (не общий); при isShared=true всегда заполнено.
  sharedSection?: 'rop_monitor' | 'smekalochnaya' | null;
  // Sorting state
  sortBy?: string | null;
  sortDir?: 'asc' | 'desc';
  // Visual column groups (super-headers). Pinned columns always render left, outside groups.
  columnGroups?: { name: string; metricIds: string[] }[];
  periodMode: PeriodMode;
  relativePeriod: RelativePeriod | null;
  comparisonMode: ComparisonMode;
  fixedPeriod: { from: string; to: string } | null;
  fixedComparison: { from: string; to: string } | null;
  createdAt: string;
}

export type SavedReportInput = Omit<SavedReport, 'id' | 'userLogin' | 'createdAt'>;
