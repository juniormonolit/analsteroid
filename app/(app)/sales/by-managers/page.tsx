import { SalesReportPage } from '@/features/reports/ui/SalesReportPage';

export default async function ByManagersPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const { new: newParam } = await searchParams;
  return <SalesReportPage reportSlug="by-managers" title="По менеджерам" isNew={newParam === '1'} />;
}
