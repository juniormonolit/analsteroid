'use client';
import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { defaultPeriod, recomputeComparison } from '@/lib/period';
import { FilterBar } from './FilterBar';
import { ReportToolbar } from './ReportToolbar';
import { ReportTable } from './ReportTable';
import { DrilldownDrawer } from './DrilldownDrawer';
import type { DealScope, Grouping, ProductGroupMode } from '@/lib/metrics/types';
import type { DateRange } from '@/lib/period';

interface Props {
  reportSlug: string;
  title: string;
}

export function SalesReportPage({ reportSlug, title }: Props) {
  const [period, setPeriod] = useState<DateRange>(defaultPeriod);
  const [comparison, setComparison] = useState<DateRange>(() => recomputeComparison(defaultPeriod()));
  const [dealScope, setDealScope] = useState<DealScope>('primary');
  const [grouping, setGrouping] = useState<Grouping>('none');
  const [metricIds, setMetricIds] = useState<string[]>(['all_core']);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [comparisonDisplay, setComparisonDisplay] = useState<'full' | 'current'>('full');
  const [productGroupMode, setProductGroupMode] = useState<ProductGroupMode>('kc');
  const [drilldown, setDrilldown] = useState<{ id: string; name: string } | null>(null);

  const handlePeriodChange = useCallback((p: DateRange) => {
    setPeriod(p);
    setComparison(recomputeComparison(p));
  }, []);

  const queryKey = ['report', reportSlug, period, comparison, dealScope, grouping, metricIds, departmentIds, productGroupMode];

  const { data, isLoading, error, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await fetch('/api/reports/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportSlug,
          period: { from: period.from.toISOString(), to: period.to.toISOString() },
          comparisonPeriod: { from: comparison.from.toISOString(), to: comparison.to.toISOString() },
          metricIds,
          dealScope,
          grouping,
          departmentIds: departmentIds.length ? departmentIds : undefined,
          productGroupMode: reportSlug === 'by-product-groups' ? productGroupMode : undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: 0,
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Section header */}
      <div className="px-6 pt-4 pb-2 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)]">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">{title}</h1>
      </div>

      {/* Filter bar */}
      <FilterBar
        period={period}
        comparison={comparison}
        departmentIds={departmentIds}
        onPeriodChange={handlePeriodChange}
        onComparisonChange={setComparison}
        onDepartmentIdsChange={setDepartmentIds}
      />

      {/* Toolbar */}
      <ReportToolbar
        dealScope={dealScope}
        grouping={grouping}
        comparisonDisplay={comparisonDisplay}
        metricIds={metricIds}
        availableMetrics={data?.metrics ?? []}
        onDealScopeChange={setDealScope}
        onGroupingChange={setGrouping}
        onComparisonDisplayChange={setComparisonDisplay}
        onMetricIdsChange={setMetricIds}
        onRefresh={() => refetch()}
        isLoading={isLoading}
        showProductGroupPicker={reportSlug === 'by-product-groups'}
        productGroupMode={productGroupMode}
        onProductGroupModeChange={setProductGroupMode}
      />

      {/* Table */}
      <div className="flex-1 overflow-hidden">
        {error ? (
          <div className="p-6 text-[var(--color-negative)] text-sm">
            Ошибка: {error instanceof Error ? error.message : 'Неизвестная ошибка'}
          </div>
        ) : (
          <ReportTable
            rows={data?.rows ?? []}
            totals={data?.totals ?? null}
            metrics={data?.metrics ?? []}
            comparisonDisplay={comparisonDisplay}
            isLoading={isLoading}
            onRowClick={reportSlug === 'by-managers'
              ? (id, name) => setDrilldown({ id, name })
              : undefined}
          />
        )}
      </div>
      {drilldown && (
        <DrilldownDrawer
          managerId={drilldown.id}
          managerName={drilldown.name}
          period={period}
          dealScope={dealScope}
          onClose={() => setDrilldown(null)}
        />
      )}
    </div>
  );
}
