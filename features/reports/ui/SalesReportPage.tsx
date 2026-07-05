'use client';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { defaultPeriod, recomputeComparison } from '@/lib/period';
import { FilterBar } from './FilterBar';
import { ReportToolbar } from './ReportToolbar';
import { ReportTable } from './ReportTable';
import { MetricPanel, getMetricPanelWidth } from './MetricPanel';
import { ViewSettings, loadViewPrefs, saveViewPrefs, DEFAULT_VIEW_PREFS, type ViewPrefs } from './ViewSettings';
import { FiltersMenu } from './FiltersMenu';
import { HighlightEditor } from './HighlightEditor';
import { SaveReportModal } from './SaveReportModal';
import { DrilldownDrawer } from './DrilldownDrawer';
import type { DrilldownTarget } from './DrilldownDrawer';
import type { DealScope, ClientType, Grouping, ProductGroupMode, ComparisonDisplay } from '@/lib/metrics/types';
import type { DateRange } from '@/lib/period';
import type { MetricHighlightConfig, SavedReport, SavedReportInput } from '@/lib/saved-reports/types';
import { resolveRelativePeriod, resolveComparison } from '@/lib/saved-reports/period';
import { type SourceDimension, type DrilldownDimension } from '@/lib/marketing/dimensions';

type MergedRow = {
  dimensionId: string;
  dimensionName: string;
  dimensionSubtitle?: string;
  teamId: string | null;
  teamName: string | null;
  deltas: Record<string, { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null }>;
};

type GroupedMergedRow = MergedRow & { isGroup?: boolean; children?: MergedRow[]; };

function applyClientGrouping(rows: MergedRow[], grouping: Grouping): GroupedMergedRow[] {
  if (grouping === 'none') return rows;

  if (grouping === 'total') {
    const totalsDeltas: Record<string, { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null }> = {};
    for (const row of rows) {
      for (const [id, d] of Object.entries(row.deltas)) {
        if (!totalsDeltas[id]) totalsDeltas[id] = { current: 0, comparison: 0, delta: null, deltaPct: null };
        totalsDeltas[id].current = (totalsDeltas[id].current ?? 0) + (d.current ?? 0);
        totalsDeltas[id].comparison = (totalsDeltas[id].comparison ?? 0) + (d.comparison ?? 0);
      }
    }
    return [{ dimensionId: '__total__', dimensionName: 'Итого', teamId: null, teamName: null, deltas: totalsDeltas, isGroup: true, children: rows }];
  }

  const order: string[] = [];
  const groups = new Map<string, MergedRow[]>();
  for (const row of rows) {
    const key = row.teamId ?? '__no_team__';
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(row);
  }

  return order.map(teamId => {
    const members = groups.get(teamId)!;
    const teamName = members[0]?.teamName ?? 'Без отдела';
    const groupDeltas: Record<string, { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null }> = {};
    for (const row of members) {
      for (const [id, d] of Object.entries(row.deltas)) {
        if (!groupDeltas[id]) groupDeltas[id] = { current: 0, comparison: 0, delta: null, deltaPct: null };
        groupDeltas[id].current = (groupDeltas[id].current ?? 0) + (d.current ?? 0);
        groupDeltas[id].comparison = (groupDeltas[id].comparison ?? 0) + (d.comparison ?? 0);
      }
    }
    for (const d of Object.values(groupDeltas)) {
      if (d.current !== null && d.comparison !== null) {
        d.delta = d.current - d.comparison;
        d.deltaPct = d.comparison !== 0 ? (d.delta / d.comparison) * 100 : null;
      }
    }
    return { dimensionId: `__team__${teamId}`, dimensionName: teamName, teamId, teamName, deltas: groupDeltas, isGroup: true, children: members };
  });
}

interface Props {
  reportSlug: string;
  title: string;
  preset?: SavedReport | null;
}

const SOURCE_DIMENSION_LABELS: Record<string, string> = {
  brand: 'Бренд', platform: 'Витрина', contact_type: 'Тип контакта',
  ad_channel: 'Канал', channel_group: 'Канал (крупно)', branch: 'Филиал', source: 'Источник',
};

const DEFAULT_METRIC_IDS = [
  'primary_deals_count',
  'primary_reservations_count',
  'primary_confirmed_count',
  'primary_sales_count',
  'primary_shipments_count',
  'primary_reservations_amount',
  'primary_confirmed_amount',
  'primary_sales_amount',
  'primary_shipments_amount',
];

export function SalesReportPage({ reportSlug, title, preset }: Props) {
  const [period, setPeriod]             = useState<DateRange>(defaultPeriod);
  const [comparison, setComparison]     = useState<DateRange>(() => recomputeComparison(defaultPeriod()));
  const [dealScope, setDealScope]       = useState<DealScope>('all');
  const [clientType, setClientType]     = useState<ClientType>('all');
  const [grouping, setGrouping]         = useState<Grouping>('none');
  const [metricIds, setMetricIds]       = useState<string[]>(DEFAULT_METRIC_IDS);
  const [fetchedMetricIds, setFetchedMetricIds] = useState<string[]>(DEFAULT_METRIC_IDS);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [comparisonDisplay, setComparisonDisplay] = useState<ComparisonDisplay>('current');
  const [metricDisplayModes, setMetricDisplayModes] = useState<Record<string, ComparisonDisplay>>({});
  const [comparisonThreshold, setComparisonThreshold] = useState<number>(5);
  const [productGroupMode, setProductGroupMode]   = useState<ProductGroupMode>('by_max');
  const [highlights, setHighlights]     = useState<Record<string, MetricHighlightConfig>>({});
  const [search, setSearch]             = useState('');
  const [drilldown, setDrilldown]       = useState<DrilldownTarget | null>(null);
  const [showMetricPanel, setShowMetricPanel]       = useState(false);
  const [showSaveModal, setShowSaveModal]           = useState(false);
  const [configuringMetricId, setConfiguringMetricId] = useState<string | null>(null);
  const [pinnedMetricIds, setPinnedMetricIds] = useState<string[]>([]);
  const [metricDecimalOverrides, setMetricDecimalOverrides] = useState<Record<string, number>>({});
  const [metricThresholdOverrides, setMetricThresholdOverrides] = useState<Record<string, number>>({});
  const [accentedMetricIds, setAccentedMetricIds] = useState<string[]>([]);
  const [barMetricIds, setBarMetricIds] = useState<string[]>([]);
  const [heatmapMetricIds, setHeatmapMetricIds] = useState<string[]>([]);
  const [heatmapInvertedIds, setHeatmapInvertedIds] = useState<string[]>([]);
  const [colorizeMetrics, setColorizeMetrics] = useState(true);
  const [themeAccent, setThemeAccent] = useState<string | null>(null); // legacy, UI выпилен
  const [numberAlign, setNumberAlign] = useState<'left' | 'center' | 'right'>('center');
  const [accountType, setAccountType] = useState<'managers' | 'logists' | 'all'>('managers');
  const [drilldownDuplicate, setDrilldownDuplicate] = useState(true);
  const [drilldownMetricIds, setDrilldownMetricIds] = useState<string[]>([]);
  const [dealFields, setDealFields] = useState<string[] | undefined>(undefined);
  const [drilldownGrouped, setDrilldownGrouped] = useState(true);
  const [sourceDimension, setSourceDimension] = useState<SourceDimension>('brand');
  const [drilldownDimension, setDrilldownDimension] = useState<DrilldownDimension>('contact_type');
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [columnGroups, setColumnGroups] = useState<{ name: string; metricIds: string[] }[]>([]);
  const [viewPrefs, setViewPrefs] = useState<ViewPrefs>(DEFAULT_VIEW_PREFS);

  useEffect(() => { setViewPrefs(loadViewPrefs()); }, []);
  function updateViewPrefs(p: ViewPrefs) { setViewPrefs(p); saveViewPrefs(p); }

  useEffect(() => {
    if (!preset) return;
    if (preset.periodMode === 'relative' && preset.relativePeriod) {
      const p = resolveRelativePeriod(preset.relativePeriod);
      const c = resolveComparison(p, preset.comparisonMode, preset.relativePeriod);
      setPeriod(p);
      setComparison(c);
    } else if (preset.fixedPeriod) {
      setPeriod({ from: new Date(preset.fixedPeriod.from), to: new Date(preset.fixedPeriod.to) });
      if (preset.fixedComparison) {
        setComparison({ from: new Date(preset.fixedComparison.from), to: new Date(preset.fixedComparison.to) });
      }
    }
    setDealScope(preset.dealScope);
    setClientType(preset.clientType);
    setGrouping(preset.grouping);
    setComparisonDisplay(preset.comparisonDisplay);
    setMetricDisplayModes(preset.metricDisplayModes ?? {});
    setComparisonThreshold(preset.comparisonThreshold ?? 5);
    setProductGroupMode(preset.productGroupMode);
    setDepartmentIds(preset.departmentIds);
    const ids = preset.metricIds.length ? preset.metricIds : ['all_core'];
    setMetricIds(ids);
    setFetchedMetricIds(ids);
    setHighlights(preset.metricHighlights ?? {});
    setPinnedMetricIds(preset.pinnedMetricIds ?? []);
    setMetricDecimalOverrides(preset.metricDecimalOverrides ?? {});
    setMetricThresholdOverrides(preset.metricThresholdOverrides ?? {});
    setAccentedMetricIds(preset.accentedMetricIds ?? []);
    setBarMetricIds(preset.barMetricIds ?? []);
    setHeatmapMetricIds(preset.heatmapMetricIds ?? []);
    setHeatmapInvertedIds(preset.heatmapInvertedIds ?? []);
    setColorizeMetrics(preset.colorizeMetrics ?? true);
    setThemeAccent(preset.themeAccent ?? null);
    setNumberAlign(preset.numberAlign ?? 'center');
    setAccountType(preset.accountType ?? 'managers');
    setDrilldownDuplicate(preset.drilldownDuplicateMetrics ?? true);
    setDrilldownMetricIds(preset.drilldownMetricIds ?? []);
    setDealFields(preset.dealFields ?? undefined);
    setDrilldownGrouped(preset.drilldownGrouped ?? true);
    setSourceDimension((preset.sourceDimension as SourceDimension) ?? 'brand');
    setDrilldownDimension((preset.drilldownDimension as DrilldownDimension) ?? 'contact_type');
    setSortBy(preset.sortBy ?? null);
    setSortDir(preset.sortDir ?? 'desc');
    setColumnGroups(preset.columnGroups ?? []);
  }, [preset?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePeriodChange = useCallback((p: DateRange) => {
    setPeriod(p);
    setComparison(recomputeComparison(p));
  }, []);

  // fetchedMetricIds only grows — removals don't trigger re-fetch, additions do
  const metricIdsForQuery = fetchedMetricIds.includes('all_core') ? ['all_core'] : [...fetchedMetricIds].sort();
  const sourceMode = reportSlug === 'by-sources';
  const queryKey = ['report', reportSlug, period, comparison, dealScope, clientType, metricIdsForQuery, departmentIds, productGroupMode, accountType, sourceMode ? sourceDimension : null];

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await fetch('/api/reports/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportSlug,
          period:           { from: period.from.toISOString(), to: period.to.toISOString() },
          comparisonPeriod: { from: comparison.from.toISOString(), to: comparison.to.toISOString() },
          metricIds,
          dealScope,
          clientType,
          departmentIds: departmentIds.length ? departmentIds : undefined,
          productGroupMode,
          accountType,
          sourceDimension: sourceMode ? sourceDimension : undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: 2 * 60 * 1000, // 2 min — prevent silent refetch on window focus
    refetchOnWindowFocus: false,
  });

  const { data: globalHighlights } = useQuery({
    queryKey: ['global-highlights'],
    queryFn: async () => {
      const res = await fetch('/api/user-highlights');
      if (!res.ok) return {};
      return res.json() as Promise<Record<string, MetricHighlightConfig>>;
    },
    staleTime: 60_000,
  });

  const effectiveHighlights = useMemo(() => ({
    ...(globalHighlights ?? {}),
    ...highlights,
  }), [globalHighlights, highlights]);

  function handleConfigureHighlightSave(config: MetricHighlightConfig | null, scope: 'report' | 'global') {
    if (!configuringMetricId) return;
    if (scope === 'global') {
      handleGlobalHighlight(configuringMetricId, config);
    }
    setHighlights(prev => {
      const next = { ...prev };
      if (config) next[configuringMetricId] = config;
      else delete next[configuringMetricId];
      return next;
    });
    setConfiguringMetricId(null);
  }

  async function handleGlobalHighlight(metricId: string, config: MetricHighlightConfig | null) {
    await fetch(`/api/user-highlights/${metricId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
  }

  async function handleSaveReport(_name: string, input: SavedReportInput) {
    await fetch('/api/saved-reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    setShowSaveModal(false);
  }

  // Full catalog for MetricPanel (all non-hidden metrics)
  const { data: catalogData } = useQuery({
    queryKey: ['metrics-catalog'],
    queryFn: async () => {
      const res = await fetch('/api/catalog/metrics');
      if (!res.ok) throw new Error('Failed to load metrics catalog');
      return res.json() as Promise<{ metrics: import('@/lib/metrics/types').Metric[] }>;
    },
    staleTime: 5 * 60 * 1000,
  });
  const catalogMetrics = catalogData?.metrics ?? [];

  const availableMetrics = data?.metrics ?? [];

  const orderedMetrics = useMemo(() => {
    const baseIds = metricIds.includes('all_core')
      ? availableMetrics.map((m: { id: string }) => m.id)
      : metricIds;
    // Reorder by column groups: grouped metrics (in group order) first, then ungrouped — preserving relative order.
    let ids = baseIds;
    if (columnGroups.length > 0) {
      const grouped = new Set<string>();
      const out: string[] = [];
      for (const g of columnGroups) {
        for (const id of g.metricIds) {
          if (baseIds.includes(id) && !grouped.has(id)) { out.push(id); grouped.add(id); }
        }
      }
      for (const id of baseIds) if (!grouped.has(id)) out.push(id);
      ids = out;
    }
    const map = new Map(catalogMetrics.map((m: import('@/lib/metrics/types').Metric) => [m.id, m]));
    return ids
      .map((id: string) => map.get(id) ?? availableMetrics.find((m: { id: string }) => m.id === id))
      .filter(Boolean);
  }, [availableMetrics, catalogMetrics, metricIds, columnGroups]);

  const dimensionType = sourceMode ? 'source' : reportSlug === 'by-product-groups' ? 'product-group' : 'manager';

  const displayRows = useMemo(() => {
    const grouped = applyClientGrouping(data?.rows ?? [], grouping);
    if (!search.trim()) return grouped;
    const q = search.trim().toLowerCase();
    if (grouping === 'none') {
      return grouped.filter(r => r.dimensionName.toLowerCase().includes(q));
    }
    return grouped
      .map(r => {
        if (!r.isGroup) return r.dimensionName.toLowerCase().includes(q) ? r : null;
        const filteredChildren = (r.children ?? []).filter(c => c.dimensionName.toLowerCase().includes(q));
        if (filteredChildren.length === 0) return null;
        return { ...r, children: filteredChildren };
      })
      .filter(Boolean) as typeof grouped;
  }, [data?.rows, grouping, search]);

  const handleRowClick = useCallback(
    (id: string, name: string) => setDrilldown({ id, name }),
    []
  );

  const handleCellClick = useCallback(
    (id: string, name: string, metricId: string) => {
      const m = catalogMetrics.find((x: { id: string }) => x.id === metricId)
        ?? availableMetrics.find((x: { id: string }) => x.id === metricId);
      setDrilldown({ id, name, metricId, metricName: m?.nameRu });
    },
    [catalogMetrics, availableMetrics]
  );

  const selectedMetricIds = metricIds.includes('all_core')
    ? availableMetrics.map((m: { id: string }) => m.id)
    : metricIds;

  const hasMixedDisplay = Object.keys(metricDisplayModes).length > 0;

  // Metric menu handlers
  function handleMetricDisplayModeChange(metricId: string, mode: ComparisonDisplay) {
    setMetricDisplayModes(prev => ({ ...prev, [metricId]: mode }));
  }

  function handleMetricRemove(metricId: string) {
    // Only update display list — fetchedMetricIds unchanged, no re-fetch
    const next = selectedMetricIds.filter((id: string) => id !== metricId);
    setMetricIds(next);
    setMetricDisplayModes(prev => {
      const copy = { ...prev };
      delete copy[metricId];
      return copy;
    });
    setAccentedMetricIds(prev => prev.filter(id => id !== metricId));
    setBarMetricIds(prev => prev.filter(id => id !== metricId));
    setHeatmapMetricIds(prev => prev.filter(id => id !== metricId));
    setHeatmapInvertedIds(prev => prev.filter(id => id !== metricId));
  }

  function handleMetricMoveLeft(metricId: string) {
    const ids = [...selectedMetricIds];
    const idx = ids.indexOf(metricId);
    if (idx <= 0) return;
    [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
    setMetricIds(ids); // always keep explicit order, never collapse to 'all_core'
  }

  function handleMetricMoveRight(metricId: string) {
    const ids = [...selectedMetricIds];
    const idx = ids.indexOf(metricId);
    if (idx < 0 || idx >= ids.length - 1) return;
    [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
    setMetricIds(ids); // always keep explicit order, never collapse to 'all_core'
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 pt-4 pb-2 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)]">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">{title}</h1>
      </div>

      <FilterBar
        period={period}
        comparison={comparison}
        departmentIds={departmentIds}
        search={search}
        grouping={sourceMode ? undefined : grouping}
        onPeriodChange={handlePeriodChange}
        onComparisonChange={setComparison}
        onDepartmentIdsChange={setDepartmentIds}
        onSearchChange={setSearch}
        onGroupingChange={sourceMode ? undefined : setGrouping}
        showDepartments={!sourceMode}
        sourceDimension={sourceMode ? sourceDimension : undefined}
        onSourceDimensionChange={sourceMode ? setSourceDimension : undefined}
        onOpenMetricPanel={() => setShowMetricPanel(true)}
        metricsBadge={metricIds.includes('all_core') ? Object.keys(highlights).length : metricIds.length}
      />

      <ReportToolbar
        dealScope={dealScope}
        comparisonDisplay={comparisonDisplay}
        hasMixedDisplay={hasMixedDisplay}
        onDealScopeChange={setDealScope}
        clientType={clientType}
        onClientTypeChange={setClientType}
        onComparisonDisplayChange={v => { setComparisonDisplay(v); setMetricDisplayModes({}); }}
        onRefresh={() => refetch()}
        isLoading={isFetching}
        viewPrefs={viewPrefs}
        onViewPrefsChange={updateViewPrefs}
        numberAlign={numberAlign}
        onNumberAlignChange={setNumberAlign}
        accountType={accountType}
        onAccountTypeChange={reportSlug === 'by-managers' ? setAccountType : undefined}
        drilldownGrouped={drilldownGrouped}
        onDrilldownGroupedChange={setDrilldownGrouped}
        colorizeMetrics={colorizeMetrics}
        onColorizeMetricsChange={setColorizeMetrics}
        showProductGroupPicker={true}
        productGroupMode={productGroupMode}
        onProductGroupModeChange={setProductGroupMode}
        onSaveReport={() => setShowSaveModal(true)}
      />

      <div className="flex-1 overflow-hidden">
        {error ? (
          <div className="p-6 text-[var(--color-negative)] text-sm">
            Ошибка: {error instanceof Error ? error.message : 'Неизвестная ошибка'}
          </div>
        ) : (
          <ReportTable
            rows={displayRows}
            totals={data?.totals ?? null}
            metrics={orderedMetrics}
            comparisonDisplay={comparisonDisplay}
            metricDisplayModes={metricDisplayModes}
            comparisonThreshold={comparisonThreshold}
            isLoading={isLoading}
            grouping={grouping}
            highlights={effectiveHighlights}
            dimensionLabel={sourceMode
              ? (SOURCE_DIMENSION_LABELS[sourceDimension] ?? 'Источник')
              : reportSlug === 'by-product-groups' ? 'Товарная группа' : 'Менеджер'}
            onRowClick={handleRowClick}
            onCellClick={handleCellClick}
            onMetricDisplayModeChange={handleMetricDisplayModeChange}
            onMetricRemove={handleMetricRemove}
            onMetricMoveLeft={handleMetricMoveLeft}
            onMetricMoveRight={handleMetricMoveRight}
            onMetricConfigure={(id) => setConfiguringMetricId(id)}
            metricDecimalOverrides={metricDecimalOverrides}
            metricThresholdOverrides={metricThresholdOverrides}
            accentedMetricIds={accentedMetricIds}
            barMetricIds={barMetricIds}
            heatmapMetricIds={heatmapMetricIds}
            heatmapInvertedIds={heatmapInvertedIds}
            colorizeMetrics={colorizeMetrics}
            numberAlign={numberAlign}
            pinnedMetricIds={pinnedMetricIds}
            onMetricPinToggle={(id) => setPinnedMetricIds(prev =>
              prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
            )}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={(by, dir) => { setSortBy(by); setSortDir(dir); }}
            columnGroups={columnGroups}
            density={viewPrefs.density}
            fontScale={viewPrefs.fontScale}
          />
        )}
      </div>

      {drilldown && (
        <DrilldownDrawer
          key={`${drilldown.id}:${drilldown.metricId ?? ''}`}
          target={drilldown}
          dimensionType={dimensionType}
          period={period}
          dealScope={dealScope}
          clientType={clientType}
          productGroupMode={productGroupMode}
          metricIds={drilldownDuplicate || drilldownMetricIds.length === 0 ? metricIds : drilldownMetricIds}
          departmentIds={departmentIds}
          dealFields={dealFields}
          sortBy={sortBy}
          sortDir={sortDir}
          grouped={drilldownGrouped}
          onGroupedChange={setDrilldownGrouped}
          sourceDimension={sourceMode ? sourceDimension : undefined}
          drilldownDimension={sourceMode ? drilldownDimension : undefined}
          onDrilldownDimensionChange={sourceMode ? setDrilldownDimension : undefined}
          toolbarExtras={
            <>
              <FiltersMenu
                dealScope={dealScope}
                onDealScopeChange={setDealScope}
                clientType={clientType}
                onClientTypeChange={setClientType}
                productGroupMode={productGroupMode}
                onProductGroupModeChange={setProductGroupMode}
                showProductGroupPicker={true}
              />
              <ViewSettings
                prefs={viewPrefs}
                onChange={updateViewPrefs}
                numberAlign={numberAlign}
                onNumberAlignChange={setNumberAlign}
                accountType={accountType}
                onAccountTypeChange={reportSlug === 'by-managers' ? setAccountType : undefined}
                drilldownGrouped={drilldownGrouped}
                onDrilldownGroupedChange={setDrilldownGrouped}
                colorizeMetrics={colorizeMetrics}
                onColorizeMetricsChange={setColorizeMetrics}
              />
            </>
          }
          onClose={() => setDrilldown(null)}
        />
      )}

      {showMetricPanel && (
        <MetricPanel
          metrics={catalogMetrics.length ? catalogMetrics : availableMetrics}
          selectedIds={selectedMetricIds}
          highlights={highlights}
          onSelectedIdsChange={ids => {
            // Никогда не схлопываем в all_core: эвристика «столько же, сколько пришло с
            // сервера» ложно срабатывала (удалил 1 → добавил 1 → весь выбор заменялся core).
            setMetricIds(ids);
            // Добавления расширяют fetch-набор (рефетч подтянет external/план-метрики);
            // удаления не рефетчат.
            setFetchedMetricIds(prev => {
              const add = ids.filter(id => !prev.includes(id));
              return add.length ? [...prev, ...add] : prev;
            });
          }}
          onHighlightsChange={setHighlights}
          onGlobalHighlight={handleGlobalHighlight}
          onClose={() => setShowMetricPanel(false)}
          onMetricConfigure={(id) => setConfiguringMetricId(id)}
          columnGroups={columnGroups}
          onColumnGroupsChange={setColumnGroups}
          drilldownDuplicate={drilldownDuplicate}
          onDrilldownDuplicateChange={setDrilldownDuplicate}
          drilldownMetricIds={drilldownMetricIds}
          onDrilldownMetricIdsChange={setDrilldownMetricIds}
          dealFields={dealFields}
          onDealFieldsChange={setDealFields}
        />
      )}

      {configuringMetricId && (() => {
        const m = catalogMetrics.find((x: { id: string }) => x.id === configuringMetricId)
          ?? availableMetrics.find((x: { id: string }) => x.id === configuringMetricId);
        return (
          <HighlightEditor
            key={configuringMetricId}
            anchorLeft={showMetricPanel ? 220 + getMetricPanelWidth() : undefined}
            metricName={m?.nameRu ?? configuringMetricId}
            dataType={m?.dataType}
            initial={effectiveHighlights[configuringMetricId] ?? null}
            onSave={handleConfigureHighlightSave}
            onClose={() => setConfiguringMetricId(null)}
            displayMode={metricDisplayModes[configuringMetricId] ?? comparisonDisplay}
            onDisplayModeChange={(mode) => handleMetricDisplayModeChange(configuringMetricId, mode)}
            isPinned={pinnedMetricIds.includes(configuringMetricId)}
            onPinToggle={() => setPinnedMetricIds(prev =>
              prev.includes(configuringMetricId!) ? prev.filter(x => x !== configuringMetricId) : [...prev, configuringMetricId!]
            )}
            isAccented={accentedMetricIds.includes(configuringMetricId)}
            onAccentToggle={() => setAccentedMetricIds(prev =>
              prev.includes(configuringMetricId!) ? prev.filter(x => x !== configuringMetricId) : [...prev, configuringMetricId!]
            )}
            isBar={barMetricIds.includes(configuringMetricId)}
            onBarToggle={() => setBarMetricIds(prev =>
              prev.includes(configuringMetricId!) ? prev.filter(x => x !== configuringMetricId) : [...prev, configuringMetricId!]
            )}
            isHeatmap={heatmapMetricIds.includes(configuringMetricId)}
            onHeatmapToggle={() => setHeatmapMetricIds(prev =>
              prev.includes(configuringMetricId!) ? prev.filter(x => x !== configuringMetricId) : [...prev, configuringMetricId!]
            )}
            isHeatmapInverted={heatmapInvertedIds.includes(configuringMetricId)}
            onHeatmapInvertToggle={() => setHeatmapInvertedIds(prev =>
              prev.includes(configuringMetricId!) ? prev.filter(x => x !== configuringMetricId) : [...prev, configuringMetricId!]
            )}
            decimalPlaces={metricDecimalOverrides[configuringMetricId] ?? m?.decimalPlaces ?? 2}
            onDecimalPlacesChange={(v) => setMetricDecimalOverrides(prev => ({ ...prev, [configuringMetricId!]: v }))}
            comparisonThreshold={metricThresholdOverrides[configuringMetricId] ?? (m?.dataType === 'percent' ? 10 : 5)}
            onComparisonThresholdChange={(v) => setMetricThresholdOverrides(prev => ({ ...prev, [configuringMetricId!]: v }))}
          />
        );
      })()}

      {showSaveModal && (
        <SaveReportModal
          reportSlug={reportSlug}
          metricIds={selectedMetricIds}
          dealScope={dealScope}
          clientType={clientType}
          grouping={grouping}
          comparisonDisplay={comparisonDisplay}
          metricDisplayModes={metricDisplayModes}
          comparisonThreshold={comparisonThreshold}
          productGroupMode={productGroupMode}
          departmentIds={departmentIds}
          highlights={highlights}
          pinnedMetricIds={pinnedMetricIds}
          metricDecimalOverrides={metricDecimalOverrides}
          metricThresholdOverrides={metricThresholdOverrides}
          accentedMetricIds={accentedMetricIds}
          barMetricIds={barMetricIds}
          heatmapMetricIds={heatmapMetricIds}
          heatmapInvertedIds={heatmapInvertedIds}
          colorizeMetrics={colorizeMetrics}
          themeAccent={themeAccent}
          numberAlign={numberAlign}
          accountType={accountType}
          drilldownDuplicate={drilldownDuplicate}
          drilldownMetricIds={drilldownMetricIds}
          dealFields={dealFields}
          drilldownGrouped={drilldownGrouped}
          sourceDimension={sourceMode ? sourceDimension : undefined}
          drilldownDimension={sourceMode ? drilldownDimension : undefined}
          sortBy={sortBy}
          sortDir={sortDir}
          columnGroups={columnGroups}
          currentPeriod={period}
          currentComparison={comparison}
          onSave={handleSaveReport}
          onClose={() => setShowSaveModal(false)}
        />
      )}
    </div>
  );
}
