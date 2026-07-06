'use client';
import { useState, useMemo, useEffect, useRef, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, ChevronDown, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { formatValue } from '@/lib/format';
import type { DateRange } from '@/lib/period';
import type { Metric } from '@/lib/metrics/types';
import { DEAL_FIELDS, DEFAULT_DEAL_FIELDS } from '@/lib/reports/dealFields';
import { DRILLDOWN_DIMENSIONS, dimensionLabel, UNDEFINED_LABEL, NO_SOURCE_LABEL, type SourceDimension, type DrilldownDimension } from '@/lib/marketing/dimensions';
import { DealCard } from './DealCard';

interface Deal {
  deal_id: number;
  deal_name: string;
  amount: string;
  created_at: string;
  sold_at: string | null;
  delivered_at: string | null;
  lost_at: string | null;
  expected_close_date: string | null;
  source_id: string | null;
  source_name: string | null;
  reserved_at: string | null;
  confirmed_at: string | null;
  manager_id: string;
  manager_name: string;
  stage_name: string | null;
  product_group_display: string;
  funnel_name: string | null;
}

export interface DrilldownTarget {
  id: string;
  name: string;
  metricId?: string;
  metricName?: string;
  // Групповые цели: подытог отдела/филиала или строка «Итого» — открывают
  // плоский список сделок всего среза (мини-отчёт по одной сущности не имеет смысла)
  kind?: 'team' | 'branch' | 'total';
}

interface Props {
  target: DrilldownTarget;
  dimensionType: 'manager' | 'product-group' | 'source';
  period: DateRange;
  dealScope: string;
  clientType?: string;
  productGroupMode: 'kc' | 'by_max';
  metricIds: string[];
  departmentIds?: string[];
  accountType?: string;
  dealFields?: string[];
  sortBy?: string | null;
  sortDir?: 'asc' | 'desc';
  // Report-level «Группировка в drilldown» setting (true = grouped mini-report, false = flat deals)
  grouped?: boolean;
  onGroupedChange?: (v: boolean) => void;
  // Marketing (by-sources): main dimension of the report + second dimension for the mini-report
  sourceDimension?: SourceDimension;
  drilldownDimension?: DrilldownDimension;
  onDrilldownDimensionChange?: (d: DrilldownDimension) => void;
  // Extra header controls (Фильтры / Вид buttons mirroring the main toolbar)
  toolbarExtras?: React.ReactNode;
  // Клик по строке сделки → карточка (проставляется обёрткой DrilldownDrawer)
  onDealOpen?: (id: number) => void;
  onClose: () => void;
}

function fmt(s: string | null) {
  if (!s) return '—';
  return format(new Date(s), 'd MMM', { locale: ru });
}
function fmtMoney(v: number | string | null) {
  const n = Number(v);
  if (!v || isNaN(n)) return '—';
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
}

type DealSort = { key: string; dir: 'asc' | 'desc' } | null;

function sortDealsBy(arr: Deal[], dealSort: DealSort): Deal[] {
  if (!dealSort) return arr;
  const def = DEAL_FIELDS.find(f => f.key === dealSort.key);
  const m = dealSort.dir === 'asc' ? 1 : -1;
  return [...arr].sort((a, b) => {
    if (dealSort.key === 'deal_id') return m * (a.deal_id - b.deal_id);
    const av = (a as unknown as Record<string, string | null>)[dealSort.key];
    const bv = (b as unknown as Record<string, string | null>)[dealSort.key];
    if (def?.kind === 'money') return m * ((Number(av) || 0) - (Number(bv) || 0));
    if (def?.kind === 'date') return m * ((av ? +new Date(av) : 0) - (bv ? +new Date(bv) : 0));
    return m * String(av ?? '').localeCompare(String(bv ?? ''), 'ru');
  });
}

// ── Deal sub-table (revealed when a product group is expanded) ──────────────
function dealCell(deal: Deal, key: string) {
  const def = DEAL_FIELDS.find(f => f.key === key);
  const v = (deal as unknown as Record<string, unknown>)[key] as string | null;
  if (key === 'deal_name') {
    return (
      <a href={`https://td.monolit-crm.ru/crm/deal/details/${deal.deal_id}/`} target="_blank" rel="noopener noreferrer"
         onClick={e => e.stopPropagation()}
         className="block truncate max-w-[420px] hover:text-[var(--color-accent)] hover:underline transition-colors" title={deal.deal_name}>
        {deal.deal_name || '—'}
      </a>
    );
  }
  if (def?.kind === 'money') return fmtMoney(v);
  if (def?.kind === 'date') return fmt(v);
  return v ?? '—';
}

function SortHead({ label, col, align, sortKey, sortDir, onSort }: {
  label: string; col: string; align?: 'left' | 'right'; sortKey?: string; sortDir?: 'asc' | 'desc'; onSort?: (k: string) => void;
}) {
  const active = sortKey === col;
  return (
    <th className={`px-3 py-2 font-medium text-[var(--color-text-muted)] whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'} ${onSort ? 'cursor-pointer select-none hover:text-[var(--color-text)]' : ''}`}
        onClick={onSort ? () => onSort(col) : undefined}>
      {label}{active && <span className="ml-0.5 text-[var(--color-accent)]">{sortDir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  );
}

function DealsTable({ deals, fields, sortKey, sortDir, onSort, stickyHead, onDealOpen }: {
  deals: Deal[]; fields: string[]; sortKey?: string; sortDir?: 'asc' | 'desc'; onSort?: (k: string) => void; stickyHead?: boolean;
  onDealOpen?: (id: number) => void;
}) {
  // Column order follows the configured `fields` order.
  const cols = fields.map(k => DEAL_FIELDS.find(f => f.key === k)).filter(Boolean) as typeof DEAL_FIELDS;
  return (
    <div className={`overflow-x-auto bg-[var(--color-bg)] pl-6 py-1 ${stickyHead ? 'overflow-y-auto h-full' : ''}`}>
      <table className="w-full text-xs border-collapse">
        <thead className={stickyHead ? 'sticky top-0 z-10 bg-[var(--color-table-header)]' : undefined}>
          <tr className="bg-[var(--color-table-header)]">
            <SortHead label="#" col="deal_id" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            {cols.map(c => (
              <SortHead key={c.key} label={c.label} col={c.key} align={c.align} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            ))}
            {/* Filler: absorbs remaining width so data columns pack left */}
            <th className="p-0 w-full" />
          </tr>
        </thead>
        <tbody>
          {deals.map((deal, i) => (
            <tr key={deal.deal_id}
                onClick={onDealOpen ? () => onDealOpen(deal.deal_id) : undefined}
                title={onDealOpen ? 'Открыть карточку сделки' : undefined}
                className={`border-t border-[var(--color-border)] hover:bg-[var(--color-table-row-hover)] ${onDealOpen ? 'cursor-pointer' : ''} ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''}`}>
              <td className="px-5 py-1.5 text-[var(--color-text-muted)] whitespace-nowrap">{deal.deal_id}</td>
              {cols.map(c => (
                <td key={c.key}
                    className={`px-3 py-1.5 whitespace-nowrap ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.kind !== 'text' ? 'text-[var(--color-text-muted)]' : ''} ${c.key === 'amount' ? 'font-medium !text-[var(--color-text)]' : ''}`}>
                  {dealCell(deal, c.key)}
                </td>
              ))}
              <td className="p-0" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Manager drilldown = mini-report: product groups × main-report metrics ───
function ManagerMiniReport({ target, period, dealScope, clientType, productGroupMode, metricIds, dealFields, sortBy, sortDir, onDealOpen }: Props) {
  const dealCols = dealFields ?? DEFAULT_DEAL_FIELDS;
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // all collapsed by default
  const [dealSort, setDealSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  // Internal sort for the mini-report rows (overrides inherited sortBy from main report)
  const [drillSort, setDrillSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(
    sortBy ? { key: sortBy, dir: sortDir ?? 'desc' } : null
  );
  function handleDrillSort(metricId: string) {
    setDrillSort(prev =>
      prev?.key === metricId
        ? { key: metricId, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key: metricId, dir: 'desc' }
    );
  }
  function onDealSort(k: string) {
    setDealSort(p => (p && p.key === k ? { key: k, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' }));
  }
  const sortDeals = (arr: Deal[]) => sortDealsBy(arr, dealSort);

  const fromIso = period.from.toISOString();
  const toIso   = period.to.toISOString();

  const { data: groupData, isLoading: groupsLoading } = useQuery({
    queryKey: ['drill-groups', target.id, fromIso, toIso, dealScope, clientType, productGroupMode, metricIds],
    queryFn: async () => {
      const res = await fetch('/api/reports/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportSlug: 'by-product-groups',
          managerId: target.id,
          period: { from: fromIso, to: toIso },
          comparisonPeriod: { from: fromIso, to: toIso }, // drill shows current only
          metricIds,
          dealScope,
          clientType,
          productGroupMode,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });

  const dealParams = new URLSearchParams({
    from: fromIso, to: toIso, scope: dealScope, productGroupMode, managerId: target.id,
    ...(clientType ? { clientType } : {}),
  });
  const { data: dealData } = useQuery({
    queryKey: ['drill-deals', target.id, fromIso, toIso, dealScope, clientType, productGroupMode],
    queryFn: () => fetch(`/api/reports/deals?${dealParams}`).then(r => r.json()),
  });

  const metrics: Metric[] = groupData?.metrics ?? [];
  type GRow = { dimensionId: string; dimensionName: string; deltas: Record<string, { current: number | null }> };
  const rawGroups: GRow[] = groupData?.rows ?? [];
  const totals: Record<string, number | null> = groupData?.totals ?? {};
  const deals: Deal[] = dealData?.deals ?? [];

  const groups = useMemo(() => {
    const arr = [...rawGroups];
    const s = drillSort;
    if (s) {
      arr.sort((a, b) => {
        const av = a.deltas[s.key]?.current ?? -Infinity;
        const bv = b.deltas[s.key]?.current ?? -Infinity;
        return (s.dir === 'asc' ? 1 : -1) * (av - bv);
      });
    }
    return arr;
  }, [rawGroups, drillSort]);

  const dealsByGroup = useMemo(() => {
    const m = new Map<string, Deal[]>();
    for (const d of deals) {
      const k = d.product_group_display;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(d);
    }
    return m;
  }, [deals]);

  function toggle(id: string) {
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  if (groupsLoading) {
    return <div className="p-6 space-y-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-10 bg-[var(--color-border)] rounded animate-pulse" />)}</div>;
  }
  if (groups.length === 0) {
    return <div className="p-10 text-center text-[var(--color-text-muted)] text-sm">Нет данных за выбранный период</div>;
  }

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-sm border-collapse">
        <thead className="sticky top-0 z-20 bg-[var(--color-table-header)]">
          <tr>
            <th className="report-thead sticky left-0 z-30 bg-[var(--color-table-header)] text-left px-4 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] w-[300px] min-w-[300px]">
              Товарная группа
            </th>
            {metrics.map(m => (
              <th key={m.id}
                  className="text-center px-3 py-2 text-xs font-medium text-[var(--color-text)] border-b border-[var(--color-border)] bg-[var(--color-table-header)] whitespace-normal leading-tight cursor-pointer hover:text-[var(--color-accent)] select-none"
                  style={{ minWidth: 90 }}
                  onClick={() => handleDrillSort(m.id)}>
                {m.nameRu}
                {drillSort?.key === m.id && <span className="ml-0.5 text-[var(--color-accent)]">{drillSort.dir === 'asc' ? '↑' : '↓'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g, i) => {
            const isOpen = expanded.has(g.dimensionId);
            const gDeals = dealsByGroup.get(g.dimensionName) ?? [];
            return (
              <Fragment key={g.dimensionId}>
                <tr
                  className={`report-row border-b border-[var(--color-border)] cursor-pointer ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : 'bg-[var(--color-bg-surface)]'}`}
                  onClick={() => toggle(g.dimensionId)}
                >
                  <td className={`sticky left-0 z-10 px-4 py-2 border-r border-[var(--color-border)] ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : 'bg-[var(--color-bg-surface)]'}`}>
                    <span className="flex items-center gap-1.5">
                      <span className="text-[var(--color-text-muted)] shrink-0">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                      <span className="font-medium truncate">{g.dimensionName}</span>
                      <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{gDeals.length} сд.</span>
                    </span>
                  </td>
                  {metrics.map(m => (
                    <td key={m.id} className="text-center px-3 py-2 tabular-nums whitespace-nowrap">
                      {formatValue(g.deltas[m.id]?.current ?? null, m.dataType, m.decimalPlaces)}
                    </td>
                  ))}
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={metrics.length + 1} className="p-0 border-b border-[var(--color-border)]">
                      {gDeals.length ? <DealsTable deals={sortDeals(gDeals)} fields={dealCols} sortKey={dealSort?.key} sortDir={dealSort?.dir} onSort={onDealSort} onDealOpen={onDealOpen} /> : <div className="px-6 py-3 text-xs text-[var(--color-text-muted)]">Нет сделок в этой группе за период</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          <tr className="font-semibold text-[var(--color-text)]">
            <td className="sticky left-0 bottom-0 z-30 bg-[var(--color-totals-bg)] px-4 py-2.5 border-r border-[var(--color-border)] border-t-2 border-t-[var(--color-accent)] uppercase tracking-wider text-[12px]">
              <span className="flex items-center gap-2">
                <span className="w-1 h-4 rounded-full bg-[var(--color-accent)] flex-shrink-0" />
                Итого
              </span>
            </td>
            {metrics.map(m => (
              <td key={m.id} className="sticky bottom-0 z-20 text-center px-3 py-2.5 tabular-nums whitespace-nowrap bg-[var(--color-totals-bg)] border-t-2 border-t-[var(--color-accent)]">
                {formatValue(totals[m.id] ?? null, m.dataType, m.decimalPlaces)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Product-group drilldown = mini-report: managers × main-report metrics ───
function ProductGroupMiniReport({ target, period, dealScope, clientType, productGroupMode, metricIds, departmentIds, dealFields, sortBy, sortDir, onDealOpen }: Props) {
  const dealCols = dealFields ?? DEFAULT_DEAL_FIELDS;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dealSort, setDealSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [drillSort, setDrillSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(
    sortBy ? { key: sortBy, dir: sortDir ?? 'desc' } : null
  );
  function handleDrillSort(metricId: string) {
    setDrillSort(prev =>
      prev?.key === metricId
        ? { key: metricId, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key: metricId, dir: 'desc' }
    );
  }
  function onDealSort(k: string) {
    setDealSort(p => (p && p.key === k ? { key: k, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' }));
  }
  const sortDeals = (arr: Deal[]) => sortDealsBy(arr, dealSort);

  const fromIso = period.from.toISOString();
  const toIso   = period.to.toISOString();

  const { data: managerData, isLoading } = useQuery({
    queryKey: ['drill-managers', target.id, fromIso, toIso, dealScope, clientType, productGroupMode, metricIds, departmentIds],
    queryFn: async () => {
      const res = await fetch('/api/reports/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportSlug: 'by-managers',
          productGroupId: target.id,
          productGroupMode,
          period: { from: fromIso, to: toIso },
          comparisonPeriod: { from: fromIso, to: toIso },
          metricIds,
          dealScope,
          clientType,
          departmentIds: departmentIds?.length ? departmentIds : undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });

  const dealParams = new URLSearchParams({
    from: fromIso, to: toIso, scope: dealScope, productGroupMode, productGroup: target.id,
    ...(clientType ? { clientType } : {}),
  });
  const { data: dealData } = useQuery({
    queryKey: ['drill-deals-pg', target.id, fromIso, toIso, dealScope, clientType, productGroupMode],
    queryFn: () => fetch(`/api/reports/deals?${dealParams}`).then(r => r.json()),
  });

  const metrics: Metric[] = managerData?.metrics ?? [];
  type MRow = { dimensionId: string; dimensionName: string; dimensionSubtitle?: string; deltas: Record<string, { current: number | null }> };
  const rawManagers: MRow[] = managerData?.rows ?? [];
  const totals: Record<string, number | null> = managerData?.totals ?? {};
  const deals: Deal[] = dealData?.deals ?? [];

  const managers = useMemo(() => {
    const arr = [...rawManagers];
    const s = drillSort;
    if (s) {
      arr.sort((a, b) => {
        const av = a.deltas[s.key]?.current ?? -Infinity;
        const bv = b.deltas[s.key]?.current ?? -Infinity;
        return (s.dir === 'asc' ? 1 : -1) * (av - bv);
      });
    }
    return arr;
  }, [rawManagers, drillSort]);

  // Group all deals for this product group by manager_id
  const dealsByManager = useMemo(() => {
    const m = new Map<string, Deal[]>();
    for (const d of deals) {
      if (!m.has(d.manager_id)) m.set(d.manager_id, []);
      m.get(d.manager_id)!.push(d);
    }
    return m;
  }, [deals]);

  function toggle(id: string) {
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  if (isLoading) {
    return <div className="p-6 space-y-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-10 bg-[var(--color-border)] rounded animate-pulse" />)}</div>;
  }
  if (managers.length === 0) {
    return <div className="p-10 text-center text-[var(--color-text-muted)] text-sm">Нет данных за выбранный период</div>;
  }

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-sm border-collapse">
        <thead className="sticky top-0 z-20 bg-[var(--color-table-header)]">
          <tr>
            <th className="report-thead sticky left-0 z-30 bg-[var(--color-table-header)] text-left px-4 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] w-[260px] min-w-[260px]">
              Менеджер
            </th>
            {metrics.map(m => (
              <th key={m.id}
                  className="text-center px-3 py-2 text-xs font-medium text-[var(--color-text)] border-b border-[var(--color-border)] bg-[var(--color-table-header)] whitespace-normal leading-tight cursor-pointer hover:text-[var(--color-accent)] select-none"
                  style={{ minWidth: 90 }}
                  onClick={() => handleDrillSort(m.id)}>
                {m.nameRu}
                {drillSort?.key === m.id && <span className="ml-0.5 text-[var(--color-accent)]">{drillSort.dir === 'asc' ? '↑' : '↓'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {managers.map((mgr, i) => {
            const isOpen = expanded.has(mgr.dimensionId);
            const mgrDeals = dealsByManager.get(mgr.dimensionId) ?? [];
            return (
              <Fragment key={mgr.dimensionId}>
                <tr
                  className={`report-row border-b border-[var(--color-border)] cursor-pointer ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : 'bg-[var(--color-bg-surface)]'}`}
                  onClick={() => toggle(mgr.dimensionId)}
                >
                  <td className={`sticky left-0 z-10 px-4 py-2 border-r border-[var(--color-border)] ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : 'bg-[var(--color-bg-surface)]'}`}>
                    <span className="flex items-center gap-1.5">
                      <span className="text-[var(--color-text-muted)] shrink-0">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                      <span className="font-medium truncate">{mgr.dimensionName}</span>
                      {mgr.dimensionSubtitle && <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{mgr.dimensionSubtitle}</span>}
                      <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{mgrDeals.length} сд.</span>
                    </span>
                  </td>
                  {metrics.map(m => (
                    <td key={m.id} className="text-center px-3 py-2 tabular-nums whitespace-nowrap">
                      {formatValue(mgr.deltas[m.id]?.current ?? null, m.dataType, m.decimalPlaces)}
                    </td>
                  ))}
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={metrics.length + 1} className="p-0 border-b border-[var(--color-border)]">
                      {mgrDeals.length ? <DealsTable deals={sortDeals(mgrDeals)} fields={dealCols} sortKey={dealSort?.key} sortDir={dealSort?.dir} onSort={onDealSort} onDealOpen={onDealOpen} /> : <div className="px-6 py-3 text-xs text-[var(--color-text-muted)]">Нет сделок в этой группе за период</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          <tr className="font-semibold text-[var(--color-text)]">
            <td className="sticky left-0 bottom-0 z-30 bg-[var(--color-totals-bg)] px-4 py-2.5 border-r border-[var(--color-border)] border-t-2 border-t-[var(--color-accent)] uppercase tracking-wider text-[12px]">
              <span className="flex items-center gap-2">
                <span className="w-1 h-4 rounded-full bg-[var(--color-accent)] flex-shrink-0" />
                Итого
              </span>
            </td>
            {metrics.map(m => (
              <td key={m.id} className="sticky bottom-0 z-20 text-center px-3 py-2.5 tabular-nums whitespace-nowrap bg-[var(--color-totals-bg)] border-t-2 border-t-[var(--color-accent)]">
                {formatValue(totals[m.id] ?? null, m.dataType, m.decimalPlaces)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Source drilldown = mini-report: second dimension × main-report metrics ──
interface SourceInfoLite { source_id: string; contact_type: string | null; branch: string | null; platform: string | null; brand: string | null; ad_channel: string | null; channel_group: string | null }

function SourceMiniReport({ target, period, dealScope, clientType, productGroupMode, metricIds, dealFields, sortBy, sortDir, sourceDimension, drilldownDimension, onDealOpen }: Props) {
  const dim: DrilldownDimension = drilldownDimension ?? 'contact_type';
  const mainDim = sourceDimension ?? 'brand';
  const dealCols = dealFields ?? DEFAULT_DEAL_FIELDS;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dealSort, setDealSort] = useState<DealSort>(null);
  function onDealSort(k: string) {
    setDealSort(p => (p && p.key === k ? { key: k, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' }));
  }
  const sortDeals = (arr: Deal[]) => sortDealsBy(arr, dealSort);

  const fromIso = period.from.toISOString();
  const toIso   = period.to.toISOString();

  const { data: runData, isLoading } = useQuery({
    queryKey: ['drill-src', mainDim, target.id, dim, fromIso, toIso, dealScope, clientType, metricIds],
    queryFn: async () => {
      const res = await fetch('/api/reports/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportSlug: dim === 'manager' ? 'by-managers' : 'by-sources',
          sourceDimension: dim === 'manager' ? undefined : dim,
          sourceFilter: { dimension: mainDim, value: target.id },
          period: { from: fromIso, to: toIso },
          comparisonPeriod: { from: fromIso, to: toIso },
          metricIds,
          dealScope,
          clientType,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });

  const dealParams = new URLSearchParams({
    from: fromIso, to: toIso, scope: dealScope, productGroupMode,
    sourceDim: mainDim, sourceVal: target.id,
    ...(clientType ? { clientType } : {}),
  });
  const { data: dealData } = useQuery({
    queryKey: ['drill-deals-src', mainDim, target.id, fromIso, toIso, dealScope, clientType],
    queryFn: () => fetch(`/api/reports/deals?${dealParams}`).then(r => r.json()),
  });

  // Справочник источников + карта менеджер→филиал — для раскладки сделок по второй сущности
  const { data: srcCatalog } = useQuery({
    queryKey: ['marketing-sources'],
    queryFn: () => fetch('/api/catalog/marketing-sources').then(r => r.json()) as Promise<{ sources: SourceInfoLite[]; managerBranches: Record<string, string> }>,
    staleTime: 10 * 60 * 1000,
    enabled: dim !== 'manager',
  });
  const srcMap = useMemo(() => new Map((srcCatalog?.sources ?? []).map(s => [s.source_id, s])), [srcCatalog]);
  const mgrBranches = srcCatalog?.managerBranches ?? {};

  const metrics: Metric[] = runData?.metrics ?? [];
  type RRow = { dimensionId: string; dimensionName: string; dimensionSubtitle?: string; deltas: Record<string, { current: number | null }> };
  const rawRows: RRow[] = runData?.rows ?? [];
  const totals: Record<string, number | null> = runData?.totals ?? {};
  const deals: Deal[] = dealData?.deals ?? [];

  const rows = useMemo(() => {
    const arr = [...rawRows];
    if (sortBy) {
      arr.sort((a, b) => {
        const av = a.deltas[sortBy]?.current ?? -Infinity;
        const bv = b.deltas[sortBy]?.current ?? -Infinity;
        return (sortDir === 'asc' ? 1 : -1) * (av - bv);
      });
    }
    return arr;
  }, [rawRows, sortBy, sortDir]);

  // Ключ бакета сделки = dimensionId строки мини-отчёта
  const dealsByRow = useMemo(() => {
    const m = new Map<string, Deal[]>();
    for (const d of deals) {
      let key: string;
      if (dim === 'manager') key = d.manager_id;
      else if (dim === 'branch') key = mgrBranches[d.manager_id] ?? UNDEFINED_LABEL; // филиал = по менеджеру сделки
      else if (dim === 'source') key = d.source_id ?? '__null__';
      else if (!d.source_id) key = NO_SOURCE_LABEL;
      else {
        const info = srcMap.get(d.source_id);
        key = info ? (info[dim] ?? UNDEFINED_LABEL) : UNDEFINED_LABEL;
      }
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(d);
    }
    return m;
  }, [deals, dim, srcMap, mgrBranches]);

  function toggle(id: string) {
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  if (isLoading) {
    return <div className="p-6 space-y-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-10 bg-[var(--color-border)] rounded animate-pulse" />)}</div>;
  }
  if (rows.length === 0) {
    return <div className="p-10 text-center text-[var(--color-text-muted)] text-sm">Нет данных за выбранный период</div>;
  }

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-sm border-collapse">
        <thead className="sticky top-0 z-20 bg-[var(--color-table-header)]">
          <tr>
            <th className="report-thead sticky left-0 z-30 bg-[var(--color-table-header)] text-left px-4 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] w-[280px] min-w-[280px]">
              {dimensionLabel(dim)}
            </th>
            {metrics.map(m => (
              <th key={m.id} className="text-center px-3 py-2 text-xs font-medium text-[var(--color-text)] border-b border-[var(--color-border)] bg-[var(--color-table-header)] whitespace-normal leading-tight" style={{ minWidth: 90 }}>
                {m.nameRu}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isOpen = expanded.has(row.dimensionId);
            const rowDeals = dealsByRow.get(row.dimensionId) ?? [];
            return (
              <Fragment key={row.dimensionId}>
                <tr
                  className={`report-row border-b border-[var(--color-border)] cursor-pointer ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : 'bg-[var(--color-bg-surface)]'}`}
                  onClick={() => toggle(row.dimensionId)}
                >
                  <td className={`sticky left-0 z-10 px-4 py-2 border-r border-[var(--color-border)] ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : 'bg-[var(--color-bg-surface)]'}`}>
                    <span className="flex items-center gap-1.5">
                      <span className="text-[var(--color-text-muted)] shrink-0">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                      <span className="font-medium truncate" title={row.dimensionName}>{row.dimensionName}</span>
                      {row.dimensionSubtitle && <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{row.dimensionSubtitle}</span>}
                      <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{rowDeals.length} сд.</span>
                    </span>
                  </td>
                  {metrics.map(m => (
                    <td key={m.id} className="text-center px-3 py-2 tabular-nums whitespace-nowrap">
                      {formatValue(row.deltas[m.id]?.current ?? null, m.dataType, m.decimalPlaces)}
                    </td>
                  ))}
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={metrics.length + 1} className="p-0 border-b border-[var(--color-border)]">
                      {rowDeals.length ? <DealsTable deals={sortDeals(rowDeals)} fields={dealCols} sortKey={dealSort?.key} sortDir={dealSort?.dir} onSort={onDealSort} onDealOpen={onDealOpen} /> : <div className="px-6 py-3 text-xs text-[var(--color-text-muted)]">Нет сделок за период</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          <tr className="font-semibold text-[var(--color-text)]">
            <td className="sticky left-0 bottom-0 z-30 bg-[var(--color-totals-bg)] px-4 py-2.5 border-r border-[var(--color-border)] border-t-2 border-t-[var(--color-accent)] uppercase tracking-wider text-[12px]">
              <span className="flex items-center gap-2">
                <span className="w-1 h-4 rounded-full bg-[var(--color-accent)] flex-shrink-0" />
                Итого
              </span>
            </td>
            {metrics.map(m => (
              <td key={m.id} className="sticky bottom-0 z-20 text-center px-3 py-2.5 tabular-nums whitespace-nowrap bg-[var(--color-totals-bg)] border-t-2 border-t-[var(--color-accent)]">
                {formatValue(totals[m.id] ?? null, m.dataType, m.decimalPlaces)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Flat deals view (grouping off / metric-filtered drill / group targets) ──
function FlatDealsView({ target, dimensionType, period, dealScope, clientType, productGroupMode, dealFields, sourceDimension, departmentIds, accountType, onDealOpen }: Props) {
  const dealCols = dealFields ?? DEFAULT_DEAL_FIELDS;
  const [dealSort, setDealSort] = useState<DealSort>(null);
  function onDealSort(k: string) {
    setDealSort(p => (p && p.key === k ? { key: k, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' }));
  }

  const fromIso = period.from.toISOString();
  const toIso   = period.to.toISOString();
  // Групповые цели: отдел → teamId; филиал → менеджерское измерение branch;
  // «Итого» → весь срез (с фильтрами отчёта по отделам и типу аккаунтов)
  const dimensionParams: Record<string, string> =
    target.kind === 'team'   ? { teamId: target.id }
    : target.kind === 'branch' ? { sourceDim: 'branch', sourceVal: target.id }
    : target.kind === 'total'  ? {
        all: '1',
        ...(departmentIds?.length ? { departmentIds: departmentIds.join(',') } : {}),
        ...(accountType && accountType !== 'all' ? { accountType } : {}),
      }
    : dimensionType === 'manager' ? { managerId: target.id }
    : dimensionType === 'source' ? { sourceDim: sourceDimension ?? 'brand', sourceVal: target.id }
    : { productGroup: target.id };
  const params = new URLSearchParams({
    from: fromIso, to: toIso, scope: dealScope, productGroupMode,
    ...(clientType ? { clientType } : {}),
    ...dimensionParams,
    ...(target.metricId ? { metricFilter: target.metricId } : {}),
  });
  const { data, isLoading } = useQuery({
    queryKey: ['drill-deals-flat', dimensionType, sourceDimension, target.kind, target.id, target.metricId, fromIso, toIso, dealScope, clientType, productGroupMode, departmentIds, accountType],
    queryFn: () => fetch(`/api/reports/deals?${params}`).then(r => r.json()),
  });
  const deals: Deal[] = data?.deals ?? [];
  const total = deals.reduce((s, d) => s + (Number(d.amount) || 0), 0);

  if (isLoading) {
    return <div className="p-6 space-y-3">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-8 bg-[var(--color-border)] rounded animate-pulse" />)}</div>;
  }
  if (deals.length === 0) {
    return <div className="p-10 text-center text-[var(--color-text-muted)] text-sm">Нет сделок за выбранный период</div>;
  }
  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-2 text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border)] shrink-0">
        {deals.length} сд. · {fmtMoney(total)}
      </div>
      <div className="flex-1 overflow-hidden">
        <DealsTable deals={sortDealsBy(deals, dealSort)} fields={dealCols} sortKey={dealSort?.key} sortDir={dealSort?.dir} onSort={onDealSort} stickyHead onDealOpen={onDealOpen} />
      </div>
    </div>
  );
}

export function DrilldownDrawer(props: Props) {
  const { target, dimensionType, period, grouped, onGroupedChange, toolbarExtras, drilldownDimension, onDrilldownDimensionChange, onClose } = props;
  // Карточка сделки (клик по строке в любом списке сделок)
  const [openDealId, setOpenDealId] = useState<number | null>(null);
  const viewProps: Props = { ...props, onDealOpen: setOpenDealId };
  // Групповые цели (отдел/филиал/итого) всегда открываются плоским списком сделок
  const isGroupTarget = !!target.kind;
  // Local grouping state: metric-click opens flat automatically; otherwise report setting.
  const [localGrouped, setLocalGrouped] = useState<boolean>(target.metricId || isGroupTarget ? false : (grouped ?? true));
  // Follow external changes of the report setting (e.g. from «Вид» inside the drawer),
  // without overriding the initial metric-click auto-flat.
  const prevGrouped = useRef(grouped);
  useEffect(() => {
    if (prevGrouped.current !== grouped) {
      prevGrouped.current = grouped;
      setLocalGrouped(grouped ?? true);
    }
  }, [grouped]);
  function handleToggle(v: boolean) {
    setLocalGrouped(v);
    // Explicit toggle is a report setting (saved with the report); the automatic
    // metric-click "нет" above is transient and doesn't touch it.
    onGroupedChange?.(v);
  }
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="w-[10%] shrink-0 bg-black/40 cursor-pointer" onClick={onClose} />
      <div className="flex-1 bg-[var(--color-bg)] flex flex-col shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-[var(--color-text)] text-base truncate">
              {target.name}
              {target.metricId && (
                <span className="ml-2 align-middle inline-block px-2 py-0.5 text-[11px] font-normal rounded-full bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)]">
                  {target.metricName ?? target.metricId}
                </span>
              )}
            </h2>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {format(period.from, 'd MMM', { locale: ru })} — {format(period.to, 'd MMM yyyy', { locale: ru })}
              {localGrouped && (dimensionType === 'manager' ? ' · по товарным группам'
                : dimensionType === 'source' ? ` · по: ${dimensionLabel(drilldownDimension ?? 'contact_type').toLowerCase()}`
                : ' · по менеджерам')}
              {!localGrouped && ' · все сделки'}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            {toolbarExtras}
            {dimensionType === 'source' && onDrilldownDimensionChange && (
              <>
                <span className="text-xs text-[var(--color-text-muted)]">Разбивка</span>
                <select
                  value={drilldownDimension ?? 'contact_type'}
                  onChange={e => onDrilldownDimensionChange(e.target.value as DrilldownDimension)}
                  className="px-2 py-1 text-xs border border-[var(--color-border)] rounded-lg bg-[var(--color-bg-surface)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                >
                  {DRILLDOWN_DIMENSIONS.map(d => (
                    <option key={d.key} value={d.key}>{d.label}</option>
                  ))}
                </select>
              </>
            )}
            {!isGroupTarget && (
              <>
                <span className="text-xs text-[var(--color-text-muted)]">Группировка</span>
                <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
                  {([true, false] as const).map(v => (
                    <button
                      key={String(v)}
                      onClick={() => handleToggle(v)}
                      className={`px-2.5 py-1 transition-colors ${localGrouped === v ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
                    >
                      {v ? 'Да' : 'Нет'}
                    </button>
                  ))}
                </div>
              </>
            )}
            <button onClick={onClose} className="p-2 hover:bg-[var(--color-bg-hover)] rounded-lg transition-colors"><X size={18} /></button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          {localGrouped && !isGroupTarget
            ? (dimensionType === 'manager' ? <ManagerMiniReport {...viewProps} />
              : dimensionType === 'source' ? <SourceMiniReport {...viewProps} />
              : <ProductGroupMiniReport {...viewProps} />)
            : <FlatDealsView {...viewProps} />}
        </div>
      </div>
      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} />}
    </div>
  );
}
