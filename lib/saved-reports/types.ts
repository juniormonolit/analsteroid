import type { DealScope, ClientType, Grouping, ProductGroupMode, ComparisonDisplay } from '@/lib/metrics/types';

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
