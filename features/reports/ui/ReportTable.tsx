'use client';
import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, ArrowDown, ChevronDown, ChevronRight, MoreVertical } from 'lucide-react';
import { formatValue, formatDelta, formatDeltaPct } from '@/lib/format';
import type { Metric, Grouping, ComparisonDisplay } from '@/lib/metrics/types';
import type { MetricHighlightConfig } from '@/lib/saved-reports/types';

function resolveHighlightColor(value: number | null, cfg: MetricHighlightConfig | undefined): string | undefined {
  if (!cfg?.enabled || value === null) return undefined;
  for (const t of cfg.thresholds) {
    if (value <= t.value) return t.color;
  }
  return cfg.aboveColor;
}

// ── Three-dots context menu ───────────────────────────────────────────────────
interface MetricMenuProps {
  metricId: string;
  isFirst: boolean;
  isLast: boolean;
  currentMode: ComparisonDisplay;
  onModeChange: (mode: ComparisonDisplay) => void;
  onRemove: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onConfigure: () => void;
}

const MODE_LABELS: Record<ComparisonDisplay, string> = {
  full: 'Полное сравнение',
  current: 'Только текущий',
  compact: 'Компактное',
};

function MetricMenu({ isFirst, isLast, currentMode, onModeChange, onRemove, onMoveLeft, onMoveRight, onConfigure }: MetricMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      const MENU_W = 192; // w-48
      setPos({ top: r.bottom + 4, left: Math.max(8, r.right - MENU_W) });
    }
    setOpen(v => !v);
  }

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        onClick={toggle}
        className="p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)] transition-colors"
        title="Настройки метрики"
      >
        <MoreVertical size={13} />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 192 }}
          className="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-lg z-[1000] py-1 text-sm"
          onClick={e => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--color-bg-hover)] transition-colors"
            onClick={() => { onConfigure(); setOpen(false); }}
          >
            Настроить
          </button>

          <div className="border-t border-[var(--color-border)] my-1" />

          <div className="flex items-center gap-1 px-3 py-1.5">
            <button
              className={`flex-1 flex items-center justify-center py-0.5 rounded hover:bg-[var(--color-bg-hover)] transition-colors ${isFirst ? 'opacity-30 cursor-not-allowed' : ''}`}
              disabled={isFirst}
              onClick={() => { if (!isFirst) { onMoveLeft(); setOpen(false); } }}
              title="Переместить влево"
            >←</button>
            <button
              className={`flex-1 flex items-center justify-center py-0.5 rounded hover:bg-[var(--color-bg-hover)] transition-colors ${isLast ? 'opacity-30 cursor-not-allowed' : ''}`}
              disabled={isLast}
              onClick={() => { if (!isLast) { onMoveRight(); setOpen(false); } }}
              title="Переместить вправо"
            >→</button>
          </div>

          <div className="border-t border-[var(--color-border)] my-1" />

          <button
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--color-bg-hover)] text-[var(--color-negative)] transition-colors"
            onClick={() => { onRemove(); setOpen(false); }}
          >
            Убрать
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Compact trend arrow ───────────────────────────────────────────────────────
function TrendArrow({ deltaPct, delta, metric, threshold }: {
  deltaPct: number | null;
  delta: number | null;
  metric: Metric;
  threshold: number;
}) {
  if (deltaPct === null) return null;
  const tooltip = `${formatDelta(delta, metric.dataType, metric.decimalPlaces)} / ${formatDeltaPct(deltaPct)}`;

  if (deltaPct > threshold) {
    return <span title={tooltip}><ArrowUp size={11} className="inline text-[var(--color-positive)] flex-shrink-0" /></span>;
  }
  if (deltaPct < -threshold) {
    return <span title={tooltip}><ArrowDown size={11} className="inline text-[var(--color-negative)] flex-shrink-0" /></span>;
  }
  return <span className="text-[10px] text-[var(--color-text-muted)] flex-shrink-0" title={tooltip}>~</span>;
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface RowDeltas {
  dimensionId: string;
  dimensionName: string;
  dimensionSubtitle?: string;
  teamName: string | null;
  isGroup?: boolean;
  children?: RowDeltas[];
  deltas: Record<string, {
    current: number | null;
    comparison: number | null;
    delta: number | null;
    deltaPct: number | null;
  }>;
}

interface Props {
  rows: RowDeltas[];
  totals: Record<string, number | null> | null;
  metrics: Metric[];
  comparisonDisplay: ComparisonDisplay;
  metricDisplayModes?: Record<string, ComparisonDisplay>;
  comparisonThreshold?: number;
  isLoading: boolean;
  grouping?: Grouping;
  dimensionLabel?: string;
  highlights?: Record<string, MetricHighlightConfig>;
  onRowClick?:  (dimensionId: string, dimensionName: string) => void;
  onCellClick?: (dimensionId: string, dimensionName: string, metricId: string) => void;
  onMetricDisplayModeChange?: (metricId: string, mode: ComparisonDisplay) => void;
  onMetricRemove?: (metricId: string) => void;
  onMetricMoveLeft?: (metricId: string) => void;
  onMetricMoveRight?: (metricId: string) => void;
  onMetricConfigure?: (metricId: string) => void;
  pinnedMetricIds?: string[];
  onMetricPinToggle?: (metricId: string) => void;
  metricDecimalOverrides?: Record<string, number>;
  metricThresholdOverrides?: Record<string, number>;
  sortBy?: string | null;
  sortDir?: 'asc' | 'desc';
  onSortChange?: (sortBy: string | null, sortDir: 'asc' | 'desc') => void;
  columnGroups?: { name: string; metricIds: string[] }[];
  density?: 'compact' | 'normal' | 'relaxed';
  fontScale?: number;
}

function thresholdFor(m: Metric, metricThresholdOverrides: Record<string, number>): number {
  if (metricThresholdOverrides[m.id] !== undefined) return metricThresholdOverrides[m.id];
  return m.dataType === 'percent' ? 10 : 5;
}

export function ReportTable({
  rows, totals, metrics, comparisonDisplay,
  metricDisplayModes = {},
  comparisonThreshold = 5,
  isLoading,
  grouping = 'none',
  dimensionLabel = 'Менеджер',
  highlights = {},
  onRowClick, onCellClick,
  onMetricDisplayModeChange,
  onMetricRemove,
  onMetricMoveLeft,
  onMetricMoveRight,
  onMetricConfigure,
  pinnedMetricIds = [],
  onMetricPinToggle,
  metricDecimalOverrides = {},
  metricThresholdOverrides = {},
  sortBy: sortByProp,
  sortDir: sortDirProp,
  onSortChange,
  columnGroups = [],
  density = 'normal',
  fontScale = 1,
}: Props) {
  const [sortByInner, setSortByInner] = useState<string | null>(null);
  const [sortDirInner, setSortDirInner] = useState<'asc' | 'desc'>('desc');
  const controlled = onSortChange !== undefined;
  const sortBy = controlled ? (sortByProp ?? null) : sortByInner;
  const sortDir = controlled ? (sortDirProp ?? 'desc') : sortDirInner;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function handleSort(metricId: string) {
    const nextDir: 'asc' | 'desc' = sortBy === metricId ? (sortDir === 'desc' ? 'asc' : 'desc') : 'desc';
    const nextBy = metricId;
    if (controlled) { onSortChange!(nextBy, nextDir); }
    else { setSortByInner(nextBy); setSortDirInner(nextDir); }
  }

  function toggleCollapse(id: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const sorted = [...rows].sort((a, b) => {
    if (!sortBy || grouping !== 'none') return 0;
    const av = a.deltas[sortBy]?.current ?? -Infinity;
    const bv = b.deltas[sortBy]?.current ?? -Infinity;
    return sortDir === 'desc' ? bv - av : av - bv;
  });

  // Pinned metrics float to the left
  const displayMetrics = [
    ...metrics.filter(m => pinnedMetricIds.includes(m.id)),
    ...metrics.filter(m => !pinnedMetricIds.includes(m.id)),
  ];

  function decFor(m: Metric): number {
    return metricDecimalOverrides[m.id] ?? m.decimalPlaces;
  }

  function resolveMode(metricId: string): ComparisonDisplay {
    return metricDisplayModes[metricId] ?? comparisonDisplay;
  }

  function colSpanFor(metricId: string): number {
    return resolveMode(metricId) === 'full' ? 4 : 1;
  }

  const DIMENSION_WIDTH = 320;
  const METRIC_COL_WIDTH = 90; // min-width per slot for non-pinned cols

  // Sticky offsets per LEAF column. A full-mode metric has 4 leaf columns
  // (Текущий/Ср/Δ/Δ%), each needs its own sticky `left` = dimension width + sum of
  // widths of all preceding pinned leaf columns. We measure offsetWidth (which is
  // INDEPENDENT of position:sticky and scroll, so it never oscillates), with a 90px
  // fallback so a momentarily-missing ref can't collapse everything to one column.
  // Refs live on HEADER cells (always rendered, never null) so measurement is reliable.
  const dimRef = useRef<HTMLTableCellElement | null>(null);
  const leafRefs = useRef<Record<string, HTMLTableCellElement | null>>({});
  const [leafOffsets, setLeafOffsets] = useState<Record<string, number>>({});

  const setLeafRef = (key: string) => (el: HTMLTableCellElement | null) => { leafRefs.current[key] = el; };
  const leafKeys = (metricId: string): string[] =>
    Array.from({ length: colSpanFor(metricId) }, (_, i) => `${metricId}:${i}`);

  // Signature of everything that affects column layout — effect recomputes only on change.
  const layoutSig = [
    pinnedMetricIds.join(','),
    displayMetrics.map(m => `${m.id}:${resolveMode(m.id)}`).join('|'),
    rows.length,
  ].join('#');

  useLayoutEffect(() => {
    if (pinnedMetricIds.length === 0) {
      setLeafOffsets(prev => (Object.keys(prev).length ? {} : prev));
      return;
    }
    function measure() {
      let offset = dimRef.current?.offsetWidth ?? DIMENSION_WIDTH;
      const next: Record<string, number> = {};
      for (const pid of pinnedMetricIds) {
        for (const key of leafKeys(pid)) {
          next[key] = offset;
          const w = leafRefs.current[key]?.offsetWidth;
          offset += (w && w > 0) ? w : METRIC_COL_WIDTH;
        }
      }
      setLeafOffsets(prev => {
        const keys = Object.keys(next);
        const same = keys.length === Object.keys(prev).length && keys.every(k => prev[k] === next[k]);
        return same ? prev : next;
      });
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSig]);

  function leafLeft(metricId: string, subIndex: number): number {
    return leafOffsets[`${metricId}:${subIndex}`] ?? DIMENSION_WIDTH;
  }
  function isMeasured(metricId: string): boolean {
    return leafOffsets[`${metricId}:0`] !== undefined;
  }

  const isClickableMetric = (m: Metric) => m.dataType !== 'percent';
  const hasAnyFullMode = displayMetrics.some(m => resolveMode(m.id) === 'full');
  const hasMenu = !!(onMetricDisplayModeChange || onMetricRemove);

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-8 bg-[var(--color-border)] rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="p-6 text-center text-[var(--color-text-muted)] text-sm">
        Нет данных за выбранный период
      </div>
    );
  }

  function renderMetricCells(row: RowDeltas, clickable: boolean, stickyBg: string) {
    return displayMetrics.map(m => {
      const d = row.deltas?.[m.id];
      const mode = resolveMode(m.id);
      const canClick = clickable && onCellClick && isClickableMetric(m);
      const isPinned = pinnedMetricIds.includes(m.id);
      const cellBase = 'tabular-nums';
      // Pinned cells must use an OPAQUE hover bg, otherwise the scrolled-under column shows through.
      const clickCls = canClick
        ? (isPinned
            ? 'cursor-pointer hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)] transition-colors'
            : 'cursor-pointer hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)] transition-colors')
        : '';
      const hlColor = resolveHighlightColor(d?.current ?? null, highlights[m.id]);
      const sizeStyle = { minWidth: METRIC_COL_WIDTH };

      // Absolute right-edge separator bar for the last pinned column (border-collapse hides
      // sticky borders, so we paint an overlay that reliably renders & scrolls with the cell).
      const pinBar = (m.id === lastPinnedId)
        ? <span className="absolute top-0 bottom-0 right-0 w-px bg-[var(--color-border)] pointer-events-none" />
        : null;

      // Per-leaf sticky props. subIdx identifies which sub-column (0..3 for full, 0 otherwise).
      // Sticky is applied only once the offset is measured, to avoid a first-paint collapse.
      const applyPin = isPinned && isMeasured(m.id);
      function leafProps(subIdx: number, withShadow: boolean): { className: string; style: React.CSSProperties } {
        // Strong shadow only on the right edge of the LAST pinned column — clean separation.
        const edge = withShadow && m.id === lastPinnedId;
        const pinnedCls = applyPin ? `sticky z-20 ${stickyBg} ${edge ? 'border-r-2 border-r-[var(--color-border-strong)]' : ''}` : '';
        const style: React.CSSProperties = applyPin
          ? { ...sizeStyle, left: leafLeft(m.id, subIdx) }
          : { ...sizeStyle };
        return { className: pinnedCls, style };
      }

      function HlValue({ value }: { value: number | null }) {
        const formatted = formatValue(value, m.dataType, decFor(m));
        if (!hlColor) return <>{formatted}</>;
        return (
          <span
            className="inline-block px-1.5 py-0.5 rounded-md text-[var(--color-text)]"
            style={{ backgroundColor: hlColor }}
          >
            {formatted}
          </span>
        );
      }

      if (mode === 'full') {
        const p0 = leafProps(0, false), p1 = leafProps(1, false), p2 = leafProps(2, false), p3 = leafProps(3, true);
        return (
          <React.Fragment key={m.id}>
            <td
              className={`text-center px-2 py-[var(--row-py)] border-l border-[var(--color-border)] ${strongLeft.has(m.id) ? sepCls : ''} ${cellBase} ${clickCls} ${p0.className}`}
              style={p0.style}
              onClick={canClick ? () => onCellClick!(row.dimensionId, row.dimensionName, m.id) : undefined}
            >
              <HlValue value={d?.current ?? null} />
            </td>
            <td className={`text-center px-2 py-[var(--row-py)] ${cellBase} text-[var(--color-text-muted)] ${p1.className}`} style={p1.style}>
              {formatValue(d?.comparison ?? null, m.dataType, decFor(m))}
            </td>
            <td className={`text-center px-2 py-[var(--row-py)] ${cellBase} ${(d?.delta ?? 0) > 0 ? 'text-[var(--color-positive)]' : (d?.delta ?? 0) < 0 ? 'text-[var(--color-negative)]' : ''} ${p2.className}`} style={p2.style}>
              {formatDelta(d?.delta ?? null, m.dataType, decFor(m))}
            </td>
            <td className={`relative text-center px-2 py-[var(--row-py)] ${cellBase} ${(d?.deltaPct ?? 0) > 0 ? 'text-[var(--color-positive)]' : (d?.deltaPct ?? 0) < 0 ? 'text-[var(--color-negative)]' : ''} ${p3.className}`} style={p3.style}>
              {formatDeltaPct(d?.deltaPct ?? null)}{pinBar}
            </td>
          </React.Fragment>
        );
      }

      if (mode === 'compact') {
        const p = leafProps(0, true);
        return (
          <td
            key={m.id}
            className={`relative text-center px-2 py-[var(--row-py)] border-l border-[var(--color-border)] ${strongLeft.has(m.id) ? sepCls : ''} ${cellBase} ${clickCls} ${p.className}`}
            style={p.style}
            onClick={canClick ? () => onCellClick!(row.dimensionId, row.dimensionName, m.id) : undefined}
          >
            {pinBar}
            <span className="inline-flex items-center justify-center">
              <HlValue value={d?.current ?? null} />
              <span className="w-4 flex-shrink-0 flex items-center justify-center">
                <TrendArrow
                  deltaPct={d?.deltaPct ?? null}
                  delta={d?.delta ?? null}
                  metric={m}
                  threshold={thresholdFor(m, metricThresholdOverrides)}
                />
              </span>
            </span>
          </td>
        );
      }

      // current
      const p = leafProps(0, true);
      return (
        <td
          key={m.id}
          className={`relative text-center px-2 py-[var(--row-py)] border-l border-[var(--color-border)] ${strongLeft.has(m.id) ? sepCls : ''} ${cellBase} ${clickCls} ${p.className}`}
          style={p.style}
          onClick={canClick ? () => onCellClick!(row.dimensionId, row.dimensionName, m.id) : undefined}
        >
          {pinBar}
          <HlValue value={d?.current ?? null} />
        </td>
      );
    });
  }

  function renderRow(row: RowDeltas, i: number, isChild = false): React.ReactNode {
    const isGroupRow = row.isGroup;
    const isCollapsed = collapsed.has(row.dimensionId);
    const hasChildren = isGroupRow && row.children && row.children.length > 0;
    const canClickRow = !isGroupRow && !!onRowClick;

    const isStripe = !isGroupRow && i % 2 === 1;
    const stickyBg = isGroupRow
      ? 'bg-[var(--color-bg-surface)]'
      : isStripe
        ? 'bg-[var(--color-table-stripe)] group-hover:bg-[var(--color-table-row-hover)]'
        : 'bg-[var(--color-bg)] group-hover:bg-[var(--color-table-row-hover)]';

    const rowCls = [
      'group border-b border-[var(--color-border)]',
      isGroupRow
        ? 'bg-[var(--color-bg-surface)] font-semibold text-[var(--color-text)]'
        : `hover:bg-[var(--color-table-row-hover)] ${isStripe ? 'bg-[var(--color-table-stripe)]' : ''}`,
    ].join(' ');

    return (
      <React.Fragment key={row.dimensionId}>
        <tr className={rowCls}>
          <td
            className={`sticky left-0 z-20 ${stickyBg} w-[320px] min-w-[320px] max-w-[320px] px-2 py-2 border-r border-[var(--color-border)] transition-colors ${canClickRow ? 'cursor-pointer' : ''}`}
            onClick={canClickRow ? () => onRowClick!(row.dimensionId, row.dimensionName) : undefined}
          >
            <div className="flex items-center gap-1">
              {isGroupRow && hasChildren ? (
                <button
                  onClick={e => { e.stopPropagation(); toggleCollapse(row.dimensionId); }}
                  className="flex-shrink-0 p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)] transition-colors"
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
              ) : (
                <span className="w-5 flex-shrink-0" />
              )}
              {isChild && <span className="w-4 flex-shrink-0 border-l-2 border-[var(--color-border)] self-stretch mr-1" />}
              <span className="min-w-0 flex-1 flex items-baseline gap-1.5 truncate">
                <span
                  className={`truncate ${isGroupRow ? 'font-semibold' : 'font-normal'} ${canClickRow ? 'hover:text-[var(--color-accent)] hover:underline transition-colors' : ''}`}
                  title={row.dimensionName}
                >
                  {row.dimensionName}
                </span>
                {!isGroupRow && row.dimensionSubtitle && (
                  <span className="text-[11px] text-[var(--color-text-muted)] flex-shrink-0 font-normal">
                    {row.dimensionSubtitle}
                  </span>
                )}
              </span>
            </div>
          </td>
          {renderMetricCells(row, !isGroupRow, stickyBg)}
        </tr>

        {isGroupRow && hasChildren && !isCollapsed &&
          row.children!.map((child, ci) => renderRow(child, ci, true))
        }
      </React.Fragment>
    );
  }

  // Super-header segments: consecutive runs of displayMetrics sharing a group (pinned cols excluded).
  const groupOf = new Map<string, string>();
  for (const g of columnGroups) for (const id of g.metricIds) groupOf.set(id, g.name);
  const hasGroups = columnGroups.length > 0;
  // Super-header segments are built over NON-pinned metrics only; pinned columns get
  // their own sticky empty cells (rendered separately) so they don't scroll/garbage.
  const nonPinnedMetrics = displayMetrics.filter(m => !pinnedMetricIds.includes(m.id));
  const superSegments: { name: string | null; span: number }[] = [];
  for (const m of nonPinnedMetrics) {
    const span = colSpanFor(m.id);
    const name = groupOf.get(m.id) ?? null;
    const last = superSegments[superSegments.length - 1];
    if (last && last.name === name) last.span += span;
    else superSegments.push({ name, span });
  }
  const lastPinnedId = [...displayMetrics].reverse().find(m => pinnedMetricIds.includes(m.id))?.id;

  // Metric ids that start a new group block — get a strong vertical separator on their left edge.
  const strongLeft = new Set<string>();
  if (hasGroups) {
    let prevKey: string | undefined;
    for (const m of displayMetrics) {
      const key = pinnedMetricIds.includes(m.id) ? '__pinned__' : (groupOf.get(m.id) ?? '__ungrouped__');
      if (prevKey !== undefined && key !== prevKey && key !== '__pinned__') strongLeft.add(m.id);
      prevKey = key;
    }
  }
  const sepCls = 'border-l-2 border-l-[var(--color-border-strong)]';

  const rowPy = density === 'compact' ? '2px' : density === 'relaxed' ? '14px' : '8px';

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-sm border-collapse" style={{ fontSize: `${14 * fontScale}px`, ['--row-py' as string]: rowPy } as React.CSSProperties}>
        <thead className="sticky top-0 z-30 bg-[var(--color-table-header)]">
          {hasGroups && (
            <tr>
              <th className="sticky left-0 z-40 bg-[var(--color-table-header)] border-b border-r border-[var(--color-border)] w-[320px] min-w-[320px] max-w-[320px]" />
              {displayMetrics.filter(m => pinnedMetricIds.includes(m.id)).map(m => {
                const pinned = isMeasured(m.id);
                return (
                  <th
                    key={m.id}
                    colSpan={colSpanFor(m.id)}
                    className={`relative border-b border-[var(--color-border)] bg-[var(--color-table-header)] ${pinned ? 'sticky z-40' : ''}`}
                    style={pinned ? { left: leafLeft(m.id, 0) } : undefined}
                  >
                    {m.id === lastPinnedId && <span className="absolute top-0 bottom-0 right-0 w-px bg-[var(--color-border)] pointer-events-none z-50" />}
                  </th>
                );
              })}
              {superSegments.map((seg, i) => (
                <th
                  key={i}
                  colSpan={seg.span}
                  className={`text-center px-2 py-1.5 text-xs font-bold uppercase tracking-wider border-b border-[var(--color-border)] bg-[var(--color-table-header)] ${seg.name ? 'text-[var(--color-text)] border-l-2 border-r-2 border-[var(--color-border-strong)]' : 'text-transparent'}`}
                >
                  {seg.name ?? ' '}
                </th>
              ))}
            </tr>
          )}
          <tr>
            <th ref={dimRef} className="sticky left-0 z-40 bg-[var(--color-table-header)] text-left px-4 py-2.5 font-medium text-[var(--color-text)] border-b border-r border-[var(--color-border)] w-[320px] min-w-[320px] max-w-[320px]">
              {dimensionLabel}
            </th>
            {displayMetrics.map((m, idx) => {
              const mode = resolveMode(m.id);
              const isFirst = idx === 0;
              const isLast = idx === displayMetrics.length - 1;
              const isPinnedCol = pinnedMetricIds.includes(m.id) && isMeasured(m.id);
              const colW = colSpanFor(m.id) * METRIC_COL_WIDTH;
              const thSize = isPinnedCol
                ? { minWidth: colW, left: leafLeft(m.id, 0) }
                : { minWidth: colW };
              // When there is no full-mode metric, no sub-header row exists, so measure
              // single-column widths from the main header cell.
              const mainRef = !hasAnyFullMode ? setLeafRef(`${m.id}:0`) : undefined;
              return (
                <th
                  key={m.id}
                  ref={mainRef}
                  colSpan={colSpanFor(m.id)}
                  className={`relative text-center px-3 py-2 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] bg-[var(--color-table-header)] group/th ${strongLeft.has(m.id) ? sepCls : ''} ${isPinnedCol ? 'sticky z-40' : ''} ${m.id === lastPinnedId ? 'border-r-2 border-r-[var(--color-border-strong)]' : ''}`}
                  style={thSize}
                >
                  {m.id === lastPinnedId && <span className="absolute top-0 bottom-0 right-0 w-px bg-[var(--color-border)] pointer-events-none z-50" />}
                  {/* Menu pinned to the top-right corner, only on hover */}
                  {hasMenu && (
                    <span className="absolute top-1 right-1 z-10 opacity-0 group-hover/th:opacity-100 transition-opacity">
                      <MetricMenu
                        metricId={m.id}
                        isFirst={isFirst}
                        isLast={isLast}
                        currentMode={mode}
                        onModeChange={newMode => onMetricDisplayModeChange?.(m.id, newMode)}
                        onRemove={() => onMetricRemove?.(m.id)}
                        onMoveLeft={() => onMetricMoveLeft?.(m.id)}
                        onMoveRight={() => onMetricMoveRight?.(m.id)}
                        onConfigure={() => onMetricConfigure?.(m.id)}
                      />
                    </span>
                  )}
                  <div className="flex items-start justify-center gap-1">
                    {sortBy === m.id && (
                      <button onClick={() => handleSort(m.id)} className="text-[var(--color-accent)] w-[14px] flex-shrink-0 mt-0.5">
                        {sortDir === 'desc' ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
                      </button>
                    )}
                    <button
                      onClick={() => handleSort(m.id)}
                      className="hover:text-[var(--color-accent)] transition-colors text-xs leading-tight text-center"
                      title={m.nameRu}
                    >
                      {m.nameRu}
                    </button>
                  </div>
                </th>
              );
            })}
          </tr>

          {hasAnyFullMode && (
            <tr className="bg-[var(--color-table-header)]">
              <th className="sticky left-0 z-40 bg-[var(--color-table-header)] border-b border-r border-[var(--color-border)] w-[320px] min-w-[320px] max-w-[320px]" />
              {displayMetrics.map(m => {
                const mode = resolveMode(m.id);
                const isPinned = pinnedMetricIds.includes(m.id) && isMeasured(m.id);
                const s = { minWidth: METRIC_COL_WIDTH };
                const sub = (i: number, base: string) => {
                  const cls = `bg-[var(--color-table-header)] ${isPinned ? 'sticky z-40' : ''} ${base}`;
                  const style = isPinned ? { ...s, left: leafLeft(m.id, i) } : s;
                  return { cls, style };
                };
                const firstBase = strongLeft.has(m.id) ? sepCls : 'border-l';
                if (mode === 'full') {
                  const a = sub(0, firstBase), b = sub(1, ''), c = sub(2, ''), e = sub(3, '');
                  return (
                    <React.Fragment key={m.id}>
                      <th ref={setLeafRef(`${m.id}:0`)} className={`text-center px-1 py-1 text-xs font-normal text-[var(--color-text-muted)] border-b border-[var(--color-border)] ${a.cls}`} style={a.style}>Тек.</th>
                      <th ref={setLeafRef(`${m.id}:1`)} className={`text-center px-1 py-1 text-xs font-normal text-[var(--color-text-muted)] border-b border-[var(--color-border)] ${b.cls}`} style={b.style}>Ср.</th>
                      <th ref={setLeafRef(`${m.id}:2`)} className={`text-center px-1 py-1 text-xs font-normal text-[var(--color-text-muted)] border-b border-[var(--color-border)] ${c.cls}`} style={c.style}>Δ</th>
                      <th ref={setLeafRef(`${m.id}:3`)} className={`relative text-center px-1 py-1 text-xs font-normal text-[var(--color-text-muted)] border-b border-[var(--color-border)] ${e.cls}`} style={e.style}>Δ%{m.id === lastPinnedId && <span className="absolute top-0 bottom-0 right-0 w-px bg-[var(--color-border)] pointer-events-none z-50" />}</th>
                    </React.Fragment>
                  );
                }
                const one = sub(0, firstBase);
                return <th key={m.id} ref={setLeafRef(`${m.id}:0`)} className={`relative border-b border-[var(--color-border)] ${one.cls}`} style={one.style}>{m.id === lastPinnedId && <span className="absolute top-0 bottom-0 right-0 w-px bg-[var(--color-border)] pointer-events-none z-50" />}</th>;
              })}
            </tr>
          )}
        </thead>
        <tbody>
          {sorted.map((row, i) => renderRow(row, i))}

          {totals && grouping === 'none' && (
            <tr className="border-t-2 border-[var(--color-border)] bg-[var(--color-table-header)] font-medium sticky bottom-0">
              <td className="sticky left-0 z-30 bg-[var(--color-table-header)] px-4 py-2 border-r border-[var(--color-border)] w-[320px] min-w-[320px] max-w-[320px]">
                Итого
              </td>
              {displayMetrics.map(m => {
                const mode = resolveMode(m.id);
                const isPinned = pinnedMetricIds.includes(m.id) && isMeasured(m.id);
                const sub = (i: number, base: string) => {
                  const cls = isPinned ? `sticky z-20 bg-[var(--color-table-header)] ${base}` : base;
                  const style = isPinned ? { left: leafLeft(m.id, i) } : undefined;
                  return { cls, style };
                };
                const firstBase = strongLeft.has(m.id) ? sepCls : 'border-l';
                if (mode === 'full') {
                  const a = sub(0, firstBase), b = sub(1, ''), c = sub(2, ''), e = sub(3, '');
                  return (
                    <React.Fragment key={m.id}>
                      <td className={`text-center px-2 py-2 tabular-nums ${a.cls}`} style={a.style}>
                        {formatValue(totals[m.id] ?? null, m.dataType, decFor(m))}
                      </td>
                      <td className={`text-center px-2 py-2 tabular-nums text-[var(--color-text-muted)] ${b.cls}`} style={b.style}>—</td>
                      <td className={`text-center px-2 py-2 tabular-nums ${c.cls}`} style={c.style}>—</td>
                      <td className={`relative text-center px-2 py-2 tabular-nums ${e.cls}`} style={e.style}>—{m.id === lastPinnedId && <span className="absolute top-0 bottom-0 right-0 w-px bg-[var(--color-border)] pointer-events-none z-50" />}</td>
                    </React.Fragment>
                  );
                }
                const one = sub(0, firstBase);
                return (
                  <td key={m.id} className={`relative text-center px-3 py-2 tabular-nums ${one.cls}`} style={one.style}>
                    {formatValue(totals[m.id] ?? null, m.dataType, decFor(m))}
                    {m.id === lastPinnedId && <span className="absolute top-0 bottom-0 right-0 w-px bg-[var(--color-border)] pointer-events-none z-50" />}
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
