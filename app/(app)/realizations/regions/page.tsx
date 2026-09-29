import { SalesReportPage } from '@/features/reports/ui/SalesReportPage';
import { REGIONS_SLUG, LOGIST_DEFAULT_METRIC_IDS, LOGIST_COLUMN_GROUPS, LOGIST_HEATMAP_ON_IDS, LOGIST_HEATMAP_INVERTED_IDS } from '@/lib/realizations/logistMetrics';

// «Реализация → Регионы» (задача #8126): та же сводка, строки — регионы (СПБ/МСК/КРД).
export const metadata = { title: 'Регионы' };

export default function Page() {
  return <SalesReportPage reportSlug={REGIONS_SLUG} title="Регионы" defaultMetricIds={LOGIST_DEFAULT_METRIC_IDS} defaultColumnGroups={LOGIST_COLUMN_GROUPS}
    defaultHeatmapMetricIds={LOGIST_HEATMAP_ON_IDS} defaultHeatmapInvertedIds={LOGIST_HEATMAP_INVERTED_IDS} />;
}
