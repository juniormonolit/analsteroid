import { SalesReportPage } from '@/features/reports/ui/SalesReportPage';
import { LOGISTS_SLUG, LOGIST_DEFAULT_METRIC_IDS, LOGIST_COLUMN_GROUPS, LOGIST_HEATMAP_ON_IDS, LOGIST_HEATMAP_INVERTED_IDS } from '@/lib/realizations/logistMetrics';

// «Реализация → Сводка по логистам» (задача #8126): отчёт на общем движке
// (SalesReportPage → /api/reports/run, slug 'realizations-logists'). Гейт — layout раздела.
export const metadata = { title: 'Сводка по логистам' };

export default function Page() {
  return <SalesReportPage reportSlug={LOGISTS_SLUG} title="Сводка по логистам" defaultMetricIds={LOGIST_DEFAULT_METRIC_IDS} defaultColumnGroups={LOGIST_COLUMN_GROUPS}
    defaultHeatmapMetricIds={LOGIST_HEATMAP_ON_IDS} defaultHeatmapInvertedIds={LOGIST_HEATMAP_INVERTED_IDS} />;
}
