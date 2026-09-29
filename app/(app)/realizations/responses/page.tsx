import { SalesReportPage } from '@/features/reports/ui/SalesReportPage';
import { RESPONSE_SLUG, RESPONSE_DEFAULT_METRIC_IDS } from '@/lib/realizations/responseMetrics';

// «Реализация → Ответы на запросы» (задача #8034) — отчёт на общем
// движке (SalesReportPage → /api/reports/run, slug 'requests-response').
// Гейт «только Администратор» — layout раздела (../layout.tsx) и run/route.ts.
export const metadata = { title: 'Ответы на запросы' };

export default function Page() {
  return <SalesReportPage reportSlug={RESPONSE_SLUG} title="Ответы на запросы" defaultMetricIds={RESPONSE_DEFAULT_METRIC_IDS} />;
}
