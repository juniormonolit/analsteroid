'use client';
import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { ArrowUp, ArrowDown, ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, Settings, GripVertical, Columns2 } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { formatValue, formatDelta, formatDeltaPct } from '@/lib/format';
import type { Metric, Grouping, ComparisonDisplay } from '@/lib/metrics/types';
import type { MetricHighlightConfig } from '@/lib/saved-reports/types';
import { mixHex } from '@/lib/colors/google-sheets-palette';

// Ручной режим подсветки значений (п.9 спеки analsteroid-edits-spec-agreed-20260708.md):
// пороги (значение+цвет, любое количество ≥1) + aboveColor — цвет «выше последнего порога»
// (без верхней границы). Между СОСЕДНИМИ порогами цвет плавно интерполируется (было —
// жёсткая ступень: цвет менялся скачком в момент пересечения порога). Ниже первого порога
// и выше последнего — сплошной цвет крайней точки (как и раньше, там менять нечего).
// Формат конфига (thresholds[]+aboveColor) НЕ меняется — это и есть «мягкая миграция
// чтением»: старые сохранённые отчёты/пороги рендерятся новой (градиентной) функцией без
// какой-либо миграции данных.
function resolveHighlightColor(value: number | null, cfg: MetricHighlightConfig | undefined): string | undefined {
  if (!cfg?.enabled || value === null) return undefined;
  if (!cfg.thresholds.length) return cfg.aboveColor;
  const sorted = [...cfg.thresholds].sort((a, b) => a.value - b.value);
  if (value <= sorted[0].value) return sorted[0].color;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (value <= b.value) {
      const t = (value - a.value) / (b.value - a.value || 1);
      return mixHex(a.color, b.color, t);
    }
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
  partial: 'Частичное (без Δ)',
  compact: 'Компактное',
  current: 'Только текущий',
};

// Цикл режимов быстрой кнопки заголовка (п. Н5б, ревизия): полное → частичное →
// компактное → текущее → снова полное. Порядок фиксирован — задаёт «глубину» сравнения
// от максимума к минимуму, не зависит от того, как метрика была настроена вручную.
const QUICK_CYCLE_ORDER: ComparisonDisplay[] = ['full', 'partial', 'compact', 'current'];
function nextQuickMode(mode: ComparisonDisplay): ComparisonDisplay {
  const idx = QUICK_CYCLE_ORDER.indexOf(mode);
  return QUICK_CYCLE_ORDER[(idx + 1) % QUICK_CYCLE_ORDER.length];
}

function MetricMenu({ isFirst, isLast, currentMode, onModeChange, onRemove, onMoveLeft, onMoveRight, onConfigure, className }: MetricMenuProps & { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-48 py-1 text-sm"
      trigger={
        <button
          // stopPropagation: клик по меню не должен триггерить сортировку в <th>
          onClick={e => e.stopPropagation()}
          className={className ?? 'tap-target p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)] transition-colors'}
          title="Настройки метрики"
        >
          <Settings size={12} />
        </button>
      }
    >
        <div onClick={e => e.stopPropagation()}>
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
        </div>
    </Popover>
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
export interface RowDeltas {
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
  // Быстрая кнопка «сравнение» в заголовке (п. Н5б спеки): включает/выключает режим
  // 'full' для ОДНОЙ метрики без похода в «Настроить». Отдельно от onMetricDisplayModeChange,
  // потому что владелец состояния (SalesReportPage) должен запомнить, в какой режим
  // возвращаться при повторном клике (current/compact, если был явно настроен) — см. Н5б.
  onMetricQuickCompareToggle?: (metricId: string) => void;
  onMetricRemove?: (metricId: string) => void;
  onMetricMoveLeft?: (metricId: string) => void;
  onMetricMoveRight?: (metricId: string) => void;
  onMetricReorder?: (draggedId: string, targetId: string) => void;
  onMetricConfigure?: (metricId: string) => void;
  pinnedMetricIds?: string[];
  onMetricPinToggle?: (metricId: string) => void;
  metricDecimalOverrides?: Record<string, number>;
  metricThresholdOverrides?: Record<string, number>;
  accentedMetricIds?: string[];
  barMetricIds?: string[];
  heatmapMetricIds?: string[];
  heatmapInvertedIds?: string[];
  colorizeMetrics?: boolean;
  numberAlign?: 'left' | 'center' | 'right';
  sortBy?: string | null;
  sortDir?: 'asc' | 'desc';
  onSortChange?: (sortBy: string | null, sortDir: 'asc' | 'desc') => void;
  columnGroups?: { name: string; metricIds: string[] }[];
  density?: 'compact' | 'normal' | 'relaxed';
  fontScale?: number;
  // Дрилл-даун: раскрытие обычной строки произвольным контентом (список сделок).
  // Управляется снаружи: onRowClick переключает, expandedRowIds хранит открытые.
  expandedRowIds?: Set<string>;
  renderExpandedRow?: (row: RowDeltas) => React.ReactNode;
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
  onMetricQuickCompareToggle,
  onMetricRemove,
  onMetricMoveLeft,
  onMetricMoveRight,
  onMetricReorder,
  onMetricConfigure,
  pinnedMetricIds = [],
  onMetricPinToggle,
  metricDecimalOverrides = {},
  metricThresholdOverrides = {},
  accentedMetricIds = [],
  barMetricIds = [],
  heatmapMetricIds = [],
  heatmapInvertedIds = [],
  colorizeMetrics = false,
  numberAlign = 'center',
  sortBy: sortByProp,
  sortDir: sortDirProp,
  onSortChange,
  columnGroups = [],
  density = 'normal',
  fontScale = 1,
  expandedRowIds,
  renderExpandedRow,
}: Props) {
  const [sortByInner, setSortByInner] = useState<string | null>(null);
  const [sortDirInner, setSortDirInner] = useState<'asc' | 'desc'>('desc');
  const controlled = onSortChange !== undefined;
  const sortBy = controlled ? (sortByProp ?? null) : sortByInner;
  const sortDir = controlled ? (sortDirProp ?? 'desc') : sortDirInner;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draggedMetricId, setDraggedMetricId] = useState<string | null>(null);
  const [dragOverMetricId, setDragOverMetricId] = useState<string | null>(null);

  // ── Плавное сворачивание сравнения (п. Н5б спеки, ревизия — 4 режима) ────────
  // Разворот в более «широкий» режим — просто mount новых колонок, CSS-анимация входа
  // проигрывается сама (см. metric-compare-col-enter в globals.css).
  // Сворачивание — обратная задача: реальный режим метрики уже сменился на более узкий
  // (меньше колонок сравнения), но колонки нужно не «выдернуть» мгновенно, а плавно
  // погасить. closingModes держит id метрик → режим, из которого метрика только что
  // ушла («from»), пока идёт затухание — на этот момент рендерим ПРЕЖНЮЮ (более
  // широкую) структуру колонок, но помечаем классом затухания только те под-колонки,
  // которых нет в НОВОМ (целевом) режиме — см. leafKinds/subColAnimCls.
  // useLayoutEffect (не useEffect!) — сравнение prev/next режима и взвод closing
  // должны случиться ДО отрисовки кадра браузером, иначе будет виден один кадр
  // мгновенного схлопывания перед тем, как включится fade-out.
  const COMPARE_CLOSE_MS = 180;
  const [closingModes, setClosingModes] = useState<Record<string, ComparisonDisplay>>({});
  const prevModeRef = useRef<Record<string, ComparisonDisplay>>({});

  // Состав «листовых» под-колонок каждого режима, в порядке отрисовки. full/partial —
  // «широкие» (>1 колонки); compact/current — одна колонка «Тек.» (у compact в ней же
  // рисуется стрелка тенденции, доп. колонки не требуется).
  function leafKinds(mode: ComparisonDisplay): ('current' | 'comparison' | 'delta' | 'deltaPct')[] {
    if (mode === 'full') return ['current', 'comparison', 'delta', 'deltaPct'];
    if (mode === 'partial') return ['current', 'comparison', 'deltaPct'];
    return ['current'];
  }
  function leafCount(mode: ComparisonDisplay): number {
    return leafKinds(mode).length;
  }
  // Режим, который сейчас нужно рендерить структурно (может отличаться от фактического
  // resolveMode на время COMPARE_CLOSE_MS после сужения режима — см. closingModes выше).
  function visualMode(metricId: string): ComparisonDisplay {
    return closingModes[metricId] ?? resolveMode(metricId);
  }
  // Класс CSS-анимации для под-колонки idx>0 под конкретный «kind»: если метрика сейчас
  // закрывается (closingModes) И этого kind нет в НОВОМ (целевом) режиме — колонка гаснет
  // (exit); иначе — обычный enter (idempotent на уже смонтированных колонках, см. коммент
  // у объявления classов в globals.css).
  function subColAnimCls(metricId: string, kind: 'comparison' | 'delta' | 'deltaPct'): string {
    const fromMode = closingModes[metricId];
    if (!fromMode) return 'metric-compare-col-enter';
    const toMode = resolveMode(metricId);
    return leafKinds(toMode).includes(kind) ? 'metric-compare-col-enter' : 'metric-compare-col-exit';
  }

  // При группировке по отделу/филиалу группы свёрнуты по умолчанию. Флаг взводится
  // при смене группировки и гасится, когда пришли строки с группами — так дефолт
  // срабатывает и для сохранённых отчётов (данные приходят позже маунта), а поиск
  // и смена периода не сбрасывают раскрытое пользователем состояние.
  const needCollapseRef = useRef(false);
  useEffect(() => {
    needCollapseRef.current = grouping === 'team' || grouping === 'branch';
  }, [grouping]);
  useEffect(() => {
    if (!needCollapseRef.current) return;
    const ids = rows.filter(r => r.isGroup).map(r => r.dimensionId);
    if (!ids.length) return;
    needCollapseRef.current = false;
    setCollapsed(new Set(ids));
  }, [rows, grouping]);

  function collapseAll() {
    setCollapsed(new Set(rows.filter(r => r.isGroup).map(r => r.dimensionId)));
  }
  function expandAll() {
    setCollapsed(new Set());
  }

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

  // Ловим сужение режима (меньше листовых колонок, чем было) ПЕРЕД покраской кадра
  // (useLayoutEffect), взводим closingModes[id] = прежний (более широкий) режим — на этом
  // же кадре колонки продолжат рендериться по прежней структуре (см. visualMode), но
  // «лишние» под-колонки получат CSS-класс затухания (subColAnimCls). Через
  // COMPARE_CLOSE_MS снимаем флаг — к этому моменту они уже прозрачны, схлопывание
  // до целевого числа колонок незаметно. Расширение режима (больше колонок) в эту
  // ветку не попадает — новые колонки просто монтируются с enter-анимацией.
  const modeSig = displayMetrics.map(m => `${m.id}:${resolveMode(m.id)}`).join('|');
  useLayoutEffect(() => {
    const justShrunk: { id: string; from: ComparisonDisplay }[] = [];
    for (const m of displayMetrics) {
      const nowMode = resolveMode(m.id);
      const prevMode = prevModeRef.current[m.id] ?? nowMode;
      if (leafCount(prevMode) > leafCount(nowMode)) justShrunk.push({ id: m.id, from: prevMode });
      prevModeRef.current[m.id] = nowMode;
    }
    if (!justShrunk.length) return;
    setClosingModes(prev => {
      const next = { ...prev };
      for (const { id, from } of justShrunk) next[id] = from;
      return next;
    });
    const timer = setTimeout(() => {
      setClosingModes(prev => {
        const next = { ...prev };
        for (const { id } of justShrunk) delete next[id];
        return next;
      });
    }, COMPARE_CLOSE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeSig]);

  function decFor(m: Metric): number {
    return metricDecimalOverrides[m.id] ?? m.decimalPlaces;
  }

  // Колонки показателей: ровная заливка всей ячейки шапки цветом категории (opaque —
  // корректно под sticky-колонками) + цветная полоска сверху. Один размер у всех ячеек,
  // никакого «заборчика» от переносов названий.
  function colorizeStyle(m: Metric): React.CSSProperties {
    return colorizeMetrics && m.color
      ? { backgroundColor: `color-mix(in srgb, ${m.color} 9%, white)` }
      : {};
  }
  function colorizeBar(m: Metric) {
    if (!colorizeMetrics || !m.color) return null;
    return <span className="absolute top-0 left-0 right-0 h-[3px] pointer-events-none" style={{ backgroundColor: m.color }} />;
  }

  // Accent: bold + tinted (opaque, so it also reads correctly under sticky pins) column.
  const accentSet = new Set(accentedMetricIds);
  function accentStyle(metricId: string): React.CSSProperties {
    // Opaque tint derived from --color-accent (mixed with white), so it recolors with the
    // report theme AND stays opaque under sticky pinned columns.
    return accentSet.has(metricId)
      ? { backgroundColor: 'color-mix(in srgb, var(--color-accent) 14%, white)', fontWeight: 600 }
      : {};
  }

  // Per-column stats over the visible LEAF data rows (group children when grouped, else the
  // row itself). Used by in-cell bars (max |current|) and heat map (min/max of current).
  const barSet = new Set(barMetricIds);
  const heatSet = new Set(heatmapMetricIds);
  const barMax: Record<string, number> = {};
  const heatStats: Record<string, number[]> = {}; // отсортированные значения колонки (для ранговой шкалы)
  if (barSet.size > 0 || heatSet.size > 0) {
    const leaves: RowDeltas[] = [];
    for (const r of rows) {
      if (r.isGroup && r.children?.length) leaves.push(...r.children);
      else if (!r.isGroup) leaves.push(r);
    }
    for (const id of barSet) {
      let max = 0;
      for (const r of leaves) {
        const v = r.deltas?.[id]?.current;
        if (v != null && Math.abs(v) > max) max = Math.abs(v);
      }
      barMax[id] = max;
    }
    for (const id of heatSet) {
      const vals: number[] = [];
      for (const r of leaves) {
        const v = r.deltas?.[id]?.current;
        if (v != null) vals.push(v);
      }
      vals.sort((a, b) => a - b);
      heatStats[id] = vals;
    }
  }

  // Heat map: red → green по РАНГУ значения в колонке (перцентильная шкала), не по
  // расстоянию до min/max. Медиана колонки — всегда середина (жёлтый); выброс (менеджер
  // с 3/3 = 100% CR) — просто самый зелёный, остальных в красное не утаскивает.
  // Равные значения получают одинаковый цвет (средний ранг). Инверсия — меньше = лучше.
  const heatInvSet = new Set(heatmapInvertedIds);
  function heatStyle(metricId: string, value: number | null): React.CSSProperties {
    if (!heatSet.has(metricId) || value == null) return {};
    const vals = heatStats[metricId];
    if (!vals || vals.length === 0) return {};
    let t: number;
    if (vals.length === 1 || vals[0] === vals[vals.length - 1]) {
      t = 0.5;
    } else {
      // Средний ранг значения: (кол-во меньших + (кол-во равных − 1) / 2) / (n − 1)
      let lo = 0; while (lo < vals.length && vals[lo] < value) lo++;
      let hi = lo; while (hi < vals.length && vals[hi] <= value) hi++;
      t = (lo + (hi - lo - 1) / 2) / (vals.length - 1);
    }
    if (heatInvSet.has(metricId)) t = 1 - t;
    return { backgroundColor: `hsl(${Math.round(t * 120)} 78% 85%)` };
  }

  // Absolute bar painted behind the value. Value content must be wrapped in a positioned
  // element so it stacks above the bar (both z auto → later DOM node wins).
  function BarBg({ metricId, value }: { metricId: string; value: number | null }) {
    if (!barSet.has(metricId) || value == null) return null;
    const max = barMax[metricId] ?? 0;
    if (max <= 0) return null;
    const pct = Math.min(100, (Math.abs(value) / max) * 100);
    return (
      <span
        className="absolute left-0 top-1 bottom-1 rounded-sm bg-[var(--color-accent)]/15 pointer-events-none"
        style={{ width: `${pct}%` }}
        aria-hidden
      />
    );
  }

  function resolveMode(metricId: string): ComparisonDisplay {
    return metricDisplayModes[metricId] ?? comparisonDisplay;
  }

  // visualMode (не голый resolveMode) — во время плавного сворачивания (closingModes)
  // колонки ещё должны занимать столько слотов, сколько было в ПРЕЖНЕМ режиме, хотя
  // реальный режим уже более узкий.
  function colSpanFor(metricId: string): number {
    return leafCount(visualMode(metricId));
  }

  const DIMENSION_WIDTH = 320;
  const METRIC_COL_WIDTH = 90; // min-width per slot for non-pinned cols
  // Итоговая строка: заметная светло-синяя непрозрачная плашка (opaque — обязательна
  // для sticky), тёмный текст, акцентная верхняя граница. Выделяется, но без инверсии.
  const TOTALS_BG = 'var(--color-totals-bg)';

  // Sticky offsets per LEAF column. A full-mode metric has 4 leaf columns
  // (Текущий/Пред/Δ/Δ%), each needs its own sticky `left` = dimension width + sum of
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
  // includes visualMode (not resolveMode) so the closing (fade-out) transient also
  // re-measures sticky offsets — column count during that window is still the wider one.
  const layoutSig = [
    pinnedMetricIds.join(','),
    displayMetrics.map(m => `${m.id}:${visualMode(m.id)}`).join('|'),
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
  const hasAnyWideMode = displayMetrics.some(m => colSpanFor(m.id) > 1);
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
    const alignStyle: React.CSSProperties = { textAlign: numberAlign };
    return displayMetrics.map(m => {
      const d = row.deltas?.[m.id];
      const mode = resolveMode(m.id);
      // Плавное сворачивание/разворачивание: vMode — структура, которую рисуем сейчас
      // (во время закрытия — прежняя, более широкая; см. visualMode/subColAnimCls выше).
      const vMode = visualMode(m.id);
      const kinds = leafKinds(vMode);
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
      const accent = accentStyle(m.id);
      const heat = heatStyle(m.id, d?.current ?? null);
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
        const pinnedCls = applyPin ? `sticky z-20 ${stickyBg} ${edge ? 'border-r border-r-[var(--color-border)]' : ''}` : '';
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
            className="inline-block px-1.5 py-0.5 rounded text-[var(--color-text)]"
            style={{ backgroundColor: `color-mix(in srgb, ${hlColor} 68%, white)` }}
          >
            {formatted}
          </span>
        );
      }

      if (kinds.length > 1) {
        // full: Тек./Пред./Δ/Δ% (4); partial: Тек./Пред./Δ% (3, без абсолютной Δ) — общий
        // рендер по составу kinds, последняя под-колонка всегда deltaPct (несёт pinBar).
        const lastIdx = kinds.length - 1;
        return (
          <React.Fragment key={m.id}>
            {kinds.map((kind, idx) => {
              const p = leafProps(idx, idx === lastIdx);
              if (kind === 'current') {
                return (
                  <td
                    key={kind}
                    className={`relative text-center px-2 py-[var(--row-py)] ${strongLeft.has(m.id) ? sepCls : ''} ${cellBase} ${clickCls} ${p.className}`}
                    style={{ ...p.style, ...accent, ...heat, ...alignStyle }}
                    onClick={canClick ? () => onCellClick!(row.dimensionId, row.dimensionName, m.id) : undefined}
                  >
                    <BarBg metricId={m.id} value={d?.current ?? null} />
                    <span className="relative"><HlValue value={d?.current ?? null} /></span>
                  </td>
                );
              }
              if (kind === 'comparison') {
                return (
                  <td key={kind} className={`text-center px-2 py-[var(--row-py)] ${cellBase} text-[var(--color-text-muted)] ${p.className} ${subColAnimCls(m.id, 'comparison')}`} style={{ ...p.style, ...accent, ...alignStyle }}>
                    {formatValue(d?.comparison ?? null, m.dataType, decFor(m))}
                  </td>
                );
              }
              if (kind === 'delta') {
                return (
                  <td key={kind} className={`text-center px-2 py-[var(--row-py)] ${cellBase} ${(d?.delta ?? 0) > 0 ? 'text-[var(--color-positive)]' : (d?.delta ?? 0) < 0 ? 'text-[var(--color-negative)]' : ''} ${p.className} ${subColAnimCls(m.id, 'delta')}`} style={{ ...p.style, ...accent, ...alignStyle }}>
                    {formatDelta(d?.delta ?? null, m.dataType, decFor(m))}
                  </td>
                );
              }
              // deltaPct — всегда последняя под-колонка, несёт разделитель закреплённого блока
              return (
                <td key={kind} className={`relative text-center px-2 py-[var(--row-py)] ${cellBase} ${(d?.deltaPct ?? 0) > 0 ? 'text-[var(--color-positive)]' : (d?.deltaPct ?? 0) < 0 ? 'text-[var(--color-negative)]' : ''} ${p.className} ${subColAnimCls(m.id, 'deltaPct')}`} style={{ ...p.style, ...accent, ...alignStyle }}>
                  {formatDeltaPct(d?.deltaPct ?? null)}{pinBar}
                </td>
              );
            })}
          </React.Fragment>
        );
      }

      if (mode === 'compact') {
        const p = leafProps(0, true);
        return (
          <td
            key={m.id}
            className={`relative text-center px-2 py-[var(--row-py)] ${strongLeft.has(m.id) ? sepCls : ''} ${cellBase} ${clickCls} ${p.className}`}
            style={{ ...p.style, ...accent, ...heat, ...alignStyle }}
            onClick={canClick ? () => onCellClick!(row.dimensionId, row.dimensionName, m.id) : undefined}
          >
            {pinBar}
            <BarBg metricId={m.id} value={d?.current ?? null} />
            <span className="relative inline-flex items-center justify-center">
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
          className={`relative text-center px-2 py-[var(--row-py)] ${strongLeft.has(m.id) ? sepCls : ''} ${cellBase} ${clickCls} ${p.className}`}
          style={{ ...p.style, ...accent, ...heat, ...alignStyle }}
          onClick={canClick ? () => onCellClick!(row.dimensionId, row.dimensionName, m.id) : undefined}
        >
          {pinBar}
          <BarBg metricId={m.id} value={d?.current ?? null} />
          <span className="relative"><HlValue value={d?.current ?? null} /></span>
        </td>
      );
    });
  }

  // Полная ширина строки-раскрытия: колонка измерения + все листовые колонки метрик
  const totalLeafCols = 1 + displayMetrics.reduce((s, m) => s + colSpanFor(m.id), 0);

  function renderRow(row: RowDeltas, i: number, isChild = false): React.ReactNode {
    const isGroupRow = row.isGroup;
    const isCollapsed = collapsed.has(row.dimensionId);
    const hasChildren = isGroupRow && row.children && row.children.length > 0;
    const canClickRow = !isGroupRow && !!onRowClick;
    // Групповая строка: клик по названию сворачивает/разворачивает группу
    const canToggleRow = isGroupRow && hasChildren;
    const expandable = !isGroupRow && !!renderExpandedRow;
    const isExpanded = expandable && !!expandedRowIds?.has(row.dimensionId);

    // Вариант C раскраски (owners-inbox/table-colors-brief.md): зебра убрана — все строки
    // отчёта на bg-surface, разделитель — тонкая линия --color-table-row-border, акцент
    // при наведении — box-shadow слева (.report-row:hover > td:first-child в globals.css).
    const stickyBg = isGroupRow
      ? 'bg-[var(--color-bg-surface)]'
      : 'bg-[var(--color-bg-surface)] group-hover:bg-[var(--color-table-row-hover)]';

    const rowCls = [
      'group border-b',
      isGroupRow
        ? 'border-[var(--color-border)] bg-[var(--color-bg-surface)] font-semibold text-[var(--color-text)]'
        : 'report-row border-[var(--color-table-row-border)] bg-[var(--color-bg-surface)]',
    ].join(' ');

    return (
      <React.Fragment key={row.dimensionId}>
        <tr className={rowCls}>
          <td
            className={`sticky left-0 z-20 ${stickyBg} w-[var(--report-dim-col)] min-w-[var(--report-dim-col)] max-w-[var(--report-dim-col)] px-2 py-2 border-r border-[var(--color-border)] transition-colors ${canClickRow || canToggleRow ? 'cursor-pointer' : ''}`}
            onClick={canClickRow
              ? () => onRowClick!(row.dimensionId, row.dimensionName)
              : canToggleRow ? () => toggleCollapse(row.dimensionId) : undefined}
          >
            <div className="flex items-center gap-1">
              {isGroupRow && hasChildren ? (
                <button
                  onClick={e => { e.stopPropagation(); toggleCollapse(row.dimensionId); }}
                  className="flex-shrink-0 p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)] transition-colors"
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
              ) : expandable ? (
                <span className="w-5 flex-shrink-0 text-[var(--color-text-muted)]">
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
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
          {renderMetricCells(row, true, stickyBg)}
        </tr>

        {isExpanded && (
          <tr>
            <td colSpan={totalLeafCols} className="p-0 border-b border-[var(--color-border)]">
              {renderExpandedRow!(row)}
            </td>
          </tr>
        )}

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
  const sepCls = 'border-l border-l-[var(--color-border)]';

  const rowPy = density === 'compact' ? '2px' : density === 'relaxed' ? '14px' : '8px';

  return (
    <div className="overflow-auto h-full bg-[var(--color-bg-surface)]">
      <table className="w-full text-sm border-collapse" style={{ fontSize: `${14 * fontScale}px`, ['--row-py' as string]: rowPy } as React.CSSProperties}>
        <thead className="report-thead sticky top-0 z-30 bg-[var(--color-table-header)]">
          {hasGroups && (
            <tr>
              <th className="sticky left-0 z-40 bg-[var(--color-table-header)] border-b border-r border-[var(--color-border)] w-[var(--report-dim-col)] min-w-[var(--report-dim-col)] max-w-[var(--report-dim-col)]" />
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
                  className={`text-center px-2 py-1.5 text-xs font-bold uppercase tracking-wider border-b border-[var(--color-border)] bg-[var(--color-table-header)] ${seg.name ? 'text-[var(--color-text)] border-l border-r border-[var(--color-border)]' : 'text-transparent'}`}
                >
                  {seg.name ?? ' '}
                </th>
              ))}
            </tr>
          )}
          <tr>
            <th ref={dimRef} className="sticky left-0 z-40 bg-[var(--color-table-header)] text-left px-4 py-2.5 font-medium text-[var(--color-text)] border-b border-r border-[var(--color-border)] w-[var(--report-dim-col)] min-w-[var(--report-dim-col)] max-w-[var(--report-dim-col)]">
              <div className="flex items-center justify-between gap-2">
                <span>{dimensionLabel}</span>
                {(grouping === 'team' || grouping === 'branch') && (
                  <span className="flex items-center gap-0.5 flex-shrink-0">
                    <button
                      onClick={expandAll}
                      title="Развернуть всё"
                      className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)] transition-colors"
                    >
                      <ChevronsDown size={14} />
                    </button>
                    <button
                      onClick={collapseAll}
                      title="Свернуть всё"
                      className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)] transition-colors"
                    >
                      <ChevronsUp size={14} />
                    </button>
                  </span>
                )}
              </div>
            </th>
            {displayMetrics.map((m, idx) => {
              const mode = resolveMode(m.id);
              const isFirst = idx === 0;
              const isLast = idx === displayMetrics.length - 1;
              const isPinnedCol = pinnedMetricIds.includes(m.id) && isMeasured(m.id);
              const span = colSpanFor(m.id);
              const colW = span * METRIC_COL_WIDTH;
              const thSize = isPinnedCol
                ? { minWidth: colW, left: leafLeft(m.id, 0) }
                : { minWidth: colW };
              // When there is no wide-mode metric, no sub-header row exists, so measure
              // single-column widths from the main header cell.
              const mainRef = !hasAnyWideMode ? setLeafRef(`${m.id}:0`) : undefined;
              return (
                <th
                  key={m.id}
                  ref={mainRef}
                  colSpan={span}
                  // Драг переехал на центральную зону полоски-сегмента (см. ниже); <th> остаётся
                  // ТОЛЬКО целью дропа (п.7 брифа metric-header-brief.md).
                  onDragOver={onMetricReorder ? e => { if (draggedMetricId && draggedMetricId !== m.id) { e.preventDefault(); setDragOverMetricId(m.id); } } : undefined}
                  onDrop={onMetricReorder ? e => {
                    e.preventDefault();
                    if (draggedMetricId && draggedMetricId !== m.id) onMetricReorder(draggedMetricId, m.id);
                    setDraggedMetricId(null); setDragOverMetricId(null);
                  } : undefined}
                  className={`relative text-center px-3 py-2 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] bg-[var(--color-table-header)] group ${strongLeft.has(m.id) ? sepCls : ''} ${isPinnedCol ? 'sticky z-40' : ''} ${m.id === lastPinnedId ? 'border-r border-r-[var(--color-border)]' : ''} ${draggedMetricId === m.id ? 'opacity-40' : ''} ${dragOverMetricId === m.id && draggedMetricId !== m.id ? 'border-l-2 border-l-[var(--color-accent)]' : ''}`}
                  style={{ ...thSize, ...colorizeStyle(m), ...accentStyle(m.id) }}
                >
                  {colorizeBar(m)}
                  {m.id === lastPinnedId && <span className="absolute top-0 bottom-0 right-0 w-px bg-[var(--color-border)] pointer-events-none z-50" />}
                  <div className="flex items-start justify-center gap-1">
                    {sortBy === m.id && (
                      <button onClick={() => handleSort(m.id)} className="tap-target text-[var(--color-accent)] w-[14px] flex-shrink-0 mt-0.5">
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
                  {/* Полоска-сегмент под названием метрики (metric-header-brief.md): слева —
                      циклический переключатель режима (full→partial→compact→current→full),
                      по центру — драг-зона (тянется, растягивается только она при раскрытом
                      сравнении), справа — шестерёнка настроек. Видна только по hover на <th>
                      (класс .group уже на <th> выше), на таче — всегда (hover-reveal). */}
                  {(onMetricQuickCompareToggle || hasMenu || onMetricReorder) && (
                    <div
                      className={`hover-reveal mt-1 flex items-stretch h-5 rounded-[7px] border border-[#dee2e6] bg-[var(--color-bg-surface)] overflow-hidden shadow-[0_1px_2px_rgba(33,37,41,0.06)] mx-auto ${span > 1 ? 'w-full' : 'w-[92px]'}`}
                      onClick={e => e.stopPropagation()}
                    >
                      {onMetricQuickCompareToggle && (
                        <button
                          onClick={e => { e.stopPropagation(); onMetricQuickCompareToggle(m.id); }}
                          className={`w-6 flex-shrink-0 flex items-center justify-center border-r border-[#dee2e6] transition-colors ${
                            mode === 'full' || mode === 'partial'
                              ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]'
                          }`}
                          title={`${MODE_LABELS[mode]} · клик — ${MODE_LABELS[nextQuickMode(mode)]}`}
                        >
                          <Columns2 size={12} />
                        </button>
                      )}
                      {onMetricReorder ? (
                        <span
                          draggable
                          onDragStart={e => { e.stopPropagation(); setDraggedMetricId(m.id); e.dataTransfer.effectAllowed = 'move'; }}
                          onDragEnd={() => { setDraggedMetricId(null); setDragOverMetricId(null); }}
                          className="flex-1 min-w-[28px] flex items-center justify-center cursor-grab bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:bg-[#f1f3f5] transition-colors"
                          title="Перетащить колонку"
                        >
                          <GripVertical size={12} />
                        </span>
                      ) : (
                        <span className="flex-1 min-w-[28px] bg-[var(--color-bg)]" />
                      )}
                      {hasMenu && (
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
                          className="w-6 flex-shrink-0 flex items-center justify-center border-l border-[#dee2e6] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition-colors"
                        />
                      )}
                    </div>
                  )}
                </th>
              );
            })}
          </tr>

          {hasAnyWideMode && (
            <tr className="bg-[var(--color-table-header)]">
              <th className="sticky left-0 z-40 bg-[var(--color-table-header)] border-b border-r border-[var(--color-border)] w-[var(--report-dim-col)] min-w-[var(--report-dim-col)] max-w-[var(--report-dim-col)]" />
              {displayMetrics.map(m => {
                const kinds = leafKinds(visualMode(m.id));
                const isPinned = pinnedMetricIds.includes(m.id) && isMeasured(m.id);
                const s = { minWidth: METRIC_COL_WIDTH };
                const sub = (i: number, base: string) => {
                  const cls = `bg-[var(--color-table-header)] ${isPinned ? 'sticky z-40' : ''} ${base}`;
                  const style = { ...(isPinned ? { ...s, left: leafLeft(m.id, i) } : s), ...colorizeStyle(m), ...accentStyle(m.id) };
                  return { cls, style };
                };
                const firstBase = strongLeft.has(m.id) ? sepCls : '';
                if (kinds.length > 1) {
                  const lastIdx = kinds.length - 1;
                  const KIND_LABEL: Record<string, string> = { current: 'Тек.', comparison: 'Пред.', delta: 'Δ', deltaPct: 'Δ%' };
                  return (
                    <React.Fragment key={m.id}>
                      {kinds.map((kind, idx) => {
                        const sb = sub(idx, idx === 0 ? firstBase : '');
                        const animCls = idx === 0 ? '' : subColAnimCls(m.id, kind as 'comparison' | 'delta' | 'deltaPct');
                        const isLast = idx === lastIdx;
                        return (
                          <th
                            key={kind}
                            ref={setLeafRef(`${m.id}:${idx}`)}
                            className={`${isLast ? 'relative' : ''} text-center px-1 py-1 text-xs font-normal text-[var(--color-text-muted)] border-b border-[var(--color-border)] ${sb.cls} ${animCls}`}
                            style={sb.style}
                          >
                            {KIND_LABEL[kind]}
                            {isLast && m.id === lastPinnedId && <span className="absolute top-0 bottom-0 right-0 w-px bg-[var(--color-border)] pointer-events-none z-50" />}
                          </th>
                        );
                      })}
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

          {totals && grouping !== 'total' && (
            <tr className="font-semibold text-[var(--color-text)]">
              <td
                className="sticky left-0 bottom-0 z-30 px-4 py-3 border-r border-[var(--color-border)] border-t-2 border-t-[var(--color-accent)] w-[var(--report-dim-col)] min-w-[var(--report-dim-col)] max-w-[var(--report-dim-col)] uppercase tracking-wider text-[12px]"
                style={{ backgroundColor: TOTALS_BG }}
              >
                <span className="flex items-center gap-2">
                  <span className="w-1 h-4 rounded-full bg-[var(--color-accent)] flex-shrink-0" />
                  Итого
                </span>
              </td>
              {displayMetrics.map(m => {
                const kinds = leafKinds(visualMode(m.id));
                const isPinned = pinnedMetricIds.includes(m.id) && isMeasured(m.id);
                const canClick = !!onCellClick && isClickableMetric(m);
                const clickCls = canClick
                  ? 'cursor-pointer hover:text-[var(--color-accent)] hover:underline transition-colors'
                  : '';
                const handleClick = canClick ? () => onCellClick!('__total__', 'Итого', m.id) : undefined;
                const sub = (i: number, base: string) => {
                  // `position: sticky` on a <tr> does NOT work with border-collapse — each cell
                  // must be sticky individually. Pin every totals cell to the bottom edge with an
                  // OPAQUE bg so scrolling data rows don't bleed through. Pinned (left) cells also
                  // carry their left offset and sit above the plain ones.
                  const cls = `sticky bottom-0 ${isPinned ? 'z-30' : 'z-20'} border-t-2 border-t-[var(--color-accent)] ${base}`;
                  const style: React.CSSProperties = { ...(isPinned ? { left: leafLeft(m.id, i) } : {}), backgroundColor: TOTALS_BG, textAlign: numberAlign };
                  return { cls, style };
                };
                const firstBase = strongLeft.has(m.id) ? sepCls : '';
                const pinSep = m.id === lastPinnedId
                  ? <span className="absolute top-0 bottom-0 right-0 w-px bg-[var(--color-border)] pointer-events-none z-50" />
                  : null;
                if (kinds.length > 1) {
                  const lastIdx = kinds.length - 1;
                  return (
                    <React.Fragment key={m.id}>
                      {kinds.map((kind, idx) => {
                        const sb = sub(idx, idx === 0 ? firstBase : '');
                        const isLast = idx === lastIdx;
                        if (kind === 'current') {
                          return (
                            <td key={kind} className={`text-center px-2 py-3 tabular-nums ${clickCls} ${sb.cls}`} style={sb.style} onClick={handleClick}>
                              {formatValue(totals[m.id] ?? null, m.dataType, decFor(m))}
                            </td>
                          );
                        }
                        const animCls = subColAnimCls(m.id, kind as 'comparison' | 'delta' | 'deltaPct');
                        return (
                          <td key={kind} className={`${isLast ? 'relative' : ''} text-center px-2 py-3 tabular-nums text-[var(--color-text-muted)] ${sb.cls} ${animCls}`} style={sb.style}>
                            —{isLast ? pinSep : null}
                          </td>
                        );
                      })}
                    </React.Fragment>
                  );
                }
                const one = sub(0, firstBase);
                return (
                  <td key={m.id} className={`relative text-center px-3 py-3 tabular-nums ${clickCls} ${one.cls}`} style={one.style} onClick={handleClick}>
                    {formatValue(totals[m.id] ?? null, m.dataType, decFor(m))}
                    {pinSep}
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
