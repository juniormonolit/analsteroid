import { SalesReportPage } from '@/features/reports/ui/SalesReportPage';

export default async function ByPeriodsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const { new: newParam } = await searchParams;
  return <SalesReportPage reportSlug="by-periods" title="По периодам" isNew={newParam === '1'} />;
}
