import { SalesReportPage } from '@/features/reports/ui/SalesReportPage';

export default async function ByProductGroupsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const { new: newParam } = await searchParams;
  return <SalesReportPage reportSlug="by-product-groups" title="По товарным группам" isNew={newParam === '1'} />;
}
