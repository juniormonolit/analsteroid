import { notFound } from 'next/navigation';
import { SalesReportPage } from '@/features/reports/ui/SalesReportPage';
import { MARKETING_PRESETS } from '@/lib/marketing/presets';
import type { SavedReport } from '@/lib/saved-reports/types';

export default async function MarketingPresetPage({
  params,
}: {
  params: Promise<{ preset: string }>;
}) {
  const { preset: key } = await params;
  const p = MARKETING_PRESETS[key];
  if (!p) return notFound();

  // Синтетический SavedReport: SalesReportPage подхватывает всё из preset-а.
  const preset: SavedReport = {
    id: `marketing:${key}`,
    userLogin: '',
    reportSlug: 'by-sources',
    name: p.title,
    metricIds: p.metricIds,
    dealScope: 'all',
    clientType: 'all',
    grouping: 'none',
    comparisonDisplay: p.comparisonDisplay ?? 'current',
    productGroupMode: 'by_max',
    departmentIds: [],
    metricHighlights: {},
    metricDisplayModes: {},
    comparisonThreshold: 5,
    sourceDimension: p.sourceDimension,
    drilldownDimension: p.drilldownDimension,
    drilldownGrouped: p.drilldownGrouped ?? true,
    periodMode: 'relative',
    relativePeriod: { anchor: 'current', unit: 'month' },
    comparisonMode: 'previous_tail',
    fixedPeriod: null,
    fixedComparison: null,
    createdAt: '',
  };

  return <SalesReportPage reportSlug="by-sources" title={p.title} preset={preset} />;
}
