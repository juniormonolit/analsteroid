import { SalesReportPage } from '@/features/reports/ui/SalesReportPage';

export default async function ByClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const { new: newParam } = await searchParams;
  return <SalesReportPage reportSlug="by-clients" title="По клиентам" isNew={newParam === '1'} />;
}
