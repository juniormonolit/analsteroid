import { SalesReportPage } from '@/features/reports/ui/SalesReportPage';
import { LOGISTS_SLUG, LOGIST_DEFAULT_METRIC_IDS, LOGIST_COLUMN_GROUPS } from '@/lib/realizations/logistMetrics';

// «Реализация → Сводка по логистам» (задача #8126): отчёт на общем движке
// (SalesReportPage → /api/reports/run, slug 'realizations-logists'). Гейт — layout раздела.
export const metadata = { title: 'Сводка по логистам' };

export default function Page() {
  return <SalesReportPage reportSlug={LOGISTS_SLUG} title="Сводка по логистам" defaultMetricIds={LOGIST_DEFAULT_METRIC_IDS} defaultColumnGroups={LOGIST_COLUMN_GROUPS} />;
}
