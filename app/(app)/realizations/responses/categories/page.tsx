import { SalesReportPage } from '@/features/reports/ui/SalesReportPage';
import { RESPONSE_CATEGORIES_SLUG, RESPONSE_DEFAULT_METRIC_IDS, RESPONSE_COLUMN_GROUPS } from '@/lib/realizations/responseMetrics';

// «Ответы на запросы → Категории»: строка = проект снабжения (группа Bitrix24).
export const metadata = { title: 'Ответы на запросы — категории' };

export default function Page() {
  return <SalesReportPage reportSlug={RESPONSE_CATEGORIES_SLUG} title="Ответы на запросы — категории" defaultMetricIds={RESPONSE_DEFAULT_METRIC_IDS} defaultColumnGroups={RESPONSE_COLUMN_GROUPS} />;
}
