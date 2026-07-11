'use client';
import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { ArrowUp, ArrowDown, ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, Settings, GripVertical, Columns2, Filter, IdCard, Search } from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { formatValue, formatDelta, formatDeltaPct } from '@/lib/format';
import type { Metric, Grouping, ComparisonDisplay, BorderMode } from '@/lib/metrics/types';
import type { MetricHighlightConfig } from '@/lib/saved-reports/types';
import type { DateRange } from '@/lib/period';
import { mixHex, GS_TINT_ROWS } from '@/lib/colors/google-sheets-palette';
import { matchesCondition, resolveThresholdZone, gradientZoneFromRank, type MetricFilters, type ZoneInfo } from '@/lib/reports/metricFilter';
import { resolveHeatmapSet } from '@/lib/metrics/heatmapDefault';
import { dimensionCountLabel } from '@/lib/format/pluralize';

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

// ── Compact trend arrow ───────────────────────────────────────────────────────
// Тултип (пред./Δ/Δ%) правка 09.07: раньше title висел на самой стрелке — наводить
// приходилось буквально на ▲/▼ (несколько пикселей). Текст тултипа теперь считает и
// вешает вызывающая сторона (компактная ячейка, см. ниже) на весь inline-блок
// (число + стрелка), TrendArrow — только сама иконка, без своего title.
function TrendArrow({ deltaPct, delta, metric, threshold }: {
  deltaPct: number | null;
  delta: number | null;
  metric: Metric;
  threshold: number;
}) {
  if (deltaPct === null) return null;
  if (deltaPct > threshold) {
    return <ArrowUp size={11} className="inline text-[var(--color-positive)] flex-shrink-0" />;
  }
  if (deltaPct < -threshold) {
    return <ArrowDown size={11} className="inline text-[var(--color-negative)] flex-shrink-0" />;
  }
  return <span className="text-[10px] text-[var(--color-text-muted)] flex-shrink-0">~</span>;
}

// Текст тултипа компактного бейджа: пред./Δ/Δ% — вынесен из TrendArrow, чтобы вешать
// его на весь бейдж (число + стрелка), не только на саму иконку стрелки.
function compactTooltip(comparison: number | null, delta: number | null, deltaPct: number | null, metric: Metric): string | undefined {
  if (deltaPct === null) return undefined;
  return `пред. ${formatValue(comparison, metric.dataType, metric.decimalPlaces)} · ${formatDelta(delta, metric.dataType, metric.decimalPlaces)} / ${formatDeltaPct(deltaPct)}`;
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
  // Итого-агрегат: та же форма, что и per-row deltas (current/comparison/delta/deltaPct) —
  // правка 09.07 (баг «Итого теряет прошлый период в развёрнутом сравнении»,
  // см. app/api/reports/run/route.ts).
  totals: Record<string, { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null }> | null;
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
  // Клик по подзаголовку измерения (dimensionSubtitle, #логин у менеджера) — открывает
  // карточку менеджера (features/manager-card), НЕ обычный дрилл-даун onRowClick.
  // Передаётся ТОЛЬКО из основной таблицы отчёта «по менеджерам» (SalesReportPage);
  // мини-отчёт дрилл-дауна (MiniReport) переиспользует ReportTable, но кладёт в
  // dimensionSubtitle «· N сд.» — там этот проп не передаётся.
  onSubtitleClick?: (dimensionId: string, dimensionName: string) => void;
  // Быстрая кнопка «сравнение» в заголовке (п. Н5б спеки): включает/выключает режим
  // 'full' для ОДНОЙ метрики без похода в «Настроить». Владелец состояния
  // (SalesReportPage) должен запомнить, в какой режим возвращаться при повторном клике
  // (current/compact, если был явно настроен) — см. Н5б.
  onMetricQuickCompareToggle?: (metricId: string) => void;
  onMetricReorder?: (draggedId: string, targetId: string) => void;
  // Шестерёнка в заголовке метрики: клик СРАЗУ открывает панель настроек метрики
  // (HighlightEditor) — раньше вела в промежуточное контекстное меню MetricMenu
  // (Настроить/←/→/Убрать), упразднённое правкой владельца 09.07 — ←/→/«Убрать»
  // переехали в саму панель настроек (см. HighlightEditor: isFirst/isLast/onMoveLeft/
  // onMoveRight/onRemove).
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
  // «Зебра» (правка владельца 09.07): лёгкая полосатость чётных строк — opt-in из панели
  // «Настройки отчёта» → «Вид», по умолчанию выкл (см. --color-report-zebra в
  // globals.css). Группа-строки (isGroupRow) и итоговая строка не полосатятся.
  zebra?: boolean;
  // Границы таблицы (п.4 правок 09.07/встреча вечер): «grid» (дефолт, полная сетка —
  // горизонтальные + вертикальные между колонками метрик) / «horizontal» (только
  // горизонтальные — было единственным поведением до этой правки) / «none» (без границ).
  // Persist как остальные опции вида (см. SavedReport.borderMode, migration 060).
  borderMode?: BorderMode;
  numberAlign?: 'left' | 'center' | 'right';
  sortBy?: string | null;
  sortDir?: 'asc' | 'desc';
  onSortChange?: (sortBy: string | null, sortDir: 'asc' | 'desc') => void;
  // Фильтр по цвету/условию + сортировка по цвету (панель настроек метрики → «Фильтр и
  // сортировка», правка владельца 09.07). Сессионное состояние, живёт в SalesReportPage
  // (как metricDisplayModes/highlights) — НЕ персистится в сохранённые отчёты.
  metricFilters?: MetricFilters;
  columnGroups?: { name: string; metricIds: string[] }[];
  density?: 'compact' | 'normal' | 'relaxed';
  // «Масштаб таблиц» ЛК (бриф 09.07, п.3, users.table_scale) — глобальный per-user
  // множитель (0.85/1/1.15), НЕ per-report настройка (была per-report fontScale,
  // упразднена — см. ViewSettings.tsx). Масштабирует и кегль, и высоту строки
  // (rowPy) пропорционально от базовых 14px/30px — см. renderRow ниже.
  tableScale?: number;
  // Дрилл-даун: раскрытие обычной строки произвольным контентом (список сделок).
  // Управляется снаружи: onRowClick переключает, expandedRowIds хранит открытые.
  expandedRowIds?: Set<string>;
  renderExpandedRow?: (row: RowDeltas) => React.ReactNode;
  // Составной empty state (задача 1698, кейс 10Б UI/UX-аудита): контекст для «диагноз»-
  // пилюли под кнопкой «Сбросить фильтры» + сам сброс. Передаётся ТОЛЬКО из основной
  // страницы отчёта (SalesReportPage) — там же живёт состояние периода/поиска/отделов.
  // Мини-отчёт дрилл-дауна (DrilldownDrawer) этот проп не передаёт — там остаётся
  // прежняя короткая надпись (см. фолбэк ниже), т.к. своего «Сбросить фильтры» у
  // мини-отчёта нет и заводить его — отдельная задача.
  emptyStateInfo?: {
    period: DateRange;
    search: string;
    departmentIds: string[];
    // Общее число отделов в оргструктуре — известно, только если родитель уже
    // подгрузил /api/catalog/org-structure (тот же React Query кэш, что у
    // DepartmentPicker). Если нет — пилюля просто не показывает «(N)».
    totalDepartments?: number;
    onResetFilters: () => void;
  };
}

function fmtEmptyStateDate(d: Date): string {
  return format(d, 'dd.MM.yyyy', { locale: ru });
}

// «Отделы: …» в диагноз-пилюле empty state: если ничего не выбрано — значит выбраны
// ВСЕ (departmentIds пуст = запрос без фильтра по отделам), показываем «все (N)» при
// известном общем числе. Если выбрано подмножество, но оно фактически покрывает все
// известные отделы — тоже «все (N)» (тот же смысл, что и пустой выбор). Иначе — «M из N»
// (или просто «M», если общее число не подгрузилось).
function emptyStateDepartmentsLabel(departmentIds: string[], totalDepartments?: number): string {
  if (departmentIds.length === 0) {
    return totalDepartments ? `все (${totalDepartments})` : 'все';
  }
  if (totalDepartments && departmentIds.length >= totalDepartments) {
    return `все (${totalDepartments})`;
  }
  return totalDepartments ? `${departmentIds.length} из ${totalDepartments}` : `${departmentIds.length}`;
}

function ReportEmptyState({ info }: { info: NonNullable<Props['emptyStateInfo']> }) {
  const { period, search, departmentIds, totalDepartments, onResetFilters } = info;
  const diagnosisParts = [
    `Период: ${fmtEmptyStateDate(period.from)} — ${fmtEmptyStateDate(period.to)}`,
    search.trim() ? `Поиск: «${search.trim()}»` : null,
    `Отделы: ${emptyStateDepartmentsLabel(departmentIds, totalDepartments)}`,
  ].filter((p): p is string => Boolean(p));

  return (
    <div className="p-10 flex flex-col items-center text-center gap-1">
      <Search size={48} strokeWidth={1.5} className="text-[var(--color-text-muted)] opacity-50 mb-2" />
      <div className="text-sm text-[var(--color-text)]">Нет данных за выбранный период</div>
      <div className="text-xs text-[var(--color-text-muted)]">Попробуйте расширить период или сбросить поиск</div>
      <button
        type="button"
        onClick={onResetFilters}
        className="mt-1.5 text-xs text-[var(--color-accent)] hover:underline"
      >
        Сбросить фильтры
      </button>
      <div className="mt-3 px-3 py-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] text-[11px] text-[var(--color-text-muted)]">
        {diagnosisParts.join(' · ')}
      </div>
    </div>
  );
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
  onRowClick, onCellClick, onSubtitleClick,
  onMetricQuickCompareToggle,
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
  zebra = false,
  borderMode = 'grid',
  numberAlign = 'center',
  sortBy: sortByProp,
  sortDir: sortDirProp,
  onSortChange,
  metricFilters = {},
  columnGroups = [],
  density = 'normal',
  tableScale = 1,
  expandedRowIds,
  renderExpandedRow,
  emptyStateInfo,
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
  // Держим тайминг СИНХРОННО с CSS-анимацией .metric-compare-col-exit (globals.css),
  // которая теперь идёт на var(--anim-duration) — единый «эпловский» тайминг всех
  // анимаций приложения (правка 09.07, см. ai_docs/fresh_docs/DESIGN_GUIDELINES.md).
  // JS-таймер не умеет читать CSS-переменную напрямую — значение продублировано
  // здесь числом; при смене --anim-duration в globals.css поменять и эту константу.
  const COMPARE_CLOSE_MS = 280;
  const [closingModes, setClosingModes] = useState<Record<string, ComparisonDisplay>>({});
  const prevModeRef = useRef<Record<string, ComparisonDisplay>>({});

  // Состав «листовых» под-колонок каждого режима, в порядке отрисовки. full/partial —
  // «широкие» (>1 колонки); compact/current — одна колонка «Тек.» (у compact в ней же
  // рисуется стрелка тенденции, доп. колонки не требуется).
  // Порядок под-колонок (правка владельца 09.07 «поменять прошлое с настоящим» —
  // хронологично было→стало): Пред. ПЕРЕД Тек., затем Δ/Δ%. Это только порядок
  // ОТРИСОВКИ — рендер каждой под-колонки читает своё поле (d.comparison/d.current)
  // по значению `kind`, а не по позиции в массиве, так что перестановка не трогает
  // расчёты/данные (см. renderMetricCells/шапку/строку «Итого» ниже — везде рендер
  // идёт по kind, не по индексу).
  function leafKinds(mode: ComparisonDisplay): ('current' | 'comparison' | 'delta' | 'deltaPct')[] {
    if (mode === 'full') return ['comparison', 'current', 'delta', 'deltaPct'];
    if (mode === 'partial') return ['comparison', 'current', 'deltaPct'];
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
      ? { backgroundColor: `color-mix(in srgb, ${m.color} 9%, var(--color-mix-base, white))` }
      : {};
  }
  function colorizeBar(m: Metric) {
    if (!colorizeMetrics || !m.color) return null;
    return <span className="absolute top-0 left-0 right-0 h-[3px] pointer-events-none" style={{ backgroundColor: m.color }} />;
  }

  // Accent (правка 09.07, встреча): заливка убрана целиком (была color-mix-заливка
  // ~14% accent) — «Акцент» теперь ТОЛЬКО полужирные значения + свои более толстые/
  // тёмные вертикальные границы колонки (см. accentEdgeCls ниже), работает в любом
  // режиме «Границ» (borderMode), не только «Сетка».
  const accentSet = new Set(accentedMetricIds);
  function accentStyle(metricId: string): React.CSSProperties {
    return accentSet.has(metricId) ? { fontWeight: 600 } : {};
  }

  // Per-column stats over the visible LEAF data rows (group children when grouped, else the
  // row itself). Used by in-cell bars (max |current|) and heat map (min/max of current).
  const barSet = new Set(barMetricIds);
  // Градиент по умолчанию у относительных метрик (п.2 правок 09.07/2): резолв «явная
  // настройка ?? (относительная ? вкл : выкл)» — см. lib/metrics/heatmapDefault.ts.
  const heatSet = resolveHeatmapSet(metrics, heatmapMetricIds);
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

  // Градиент: red → green по РАНГУ значения в колонке (перцентильная шкала), не по
  // расстоянию до min/max. Медиана колонки — всегда середина (жёлтый); выброс (менеджер
  // с 3/3 = 100% CR) — просто самый зелёный, остальных в красное не утаскивает.
  // Равные значения получают одинаковый цвет (средний ранг). Инверсия — меньше = лучше.
  //
  // Красит БЕЙДЖ вокруг значения (HlValue), тем же механизмом, что и ручные пороги —
  // не заливает фон ячейки. Раньше заливался td.backgroundColor (heatStyle) — визуально
  // выглядело как окраска всей ячейки, а не значения; порогово-градиентная подсветка
  // теперь единообразна (см. hlColor ниже).
  const heatInvSet = new Set(heatmapInvertedIds);
  // Опорные цвета градиента (правка 09.07, п.8 встречи): раньше здесь был насыщенный
  // hsl(t*120, 70%, 50%) — визуально гораздо ярче/темнее ручных порогов (у тех исходный
  // цвет уже пастельный — тон из GS_TINT_ROWS[4], подмес 80% к белому, ДО повторного
  // color-mix(68%, white) в HlValue). Приводим градиент к ТОЙ ЖЕ гамме: интерполяция
  // красный→жёлтый→зелёный по тем же самым опорным пастельным тонам, что и дефолтные
  // цвета ручных порогов (см. DEFAULT_STOP_COLORS в HighlightEditor.tsx — [1]/[3]/[4] той
  // же строки палитры). Зоны фильтра по цвету (metricFilter.gradientZoneFromRank) читают
  // РАНГ t напрямую и этой правки не касаются — границы зон не меняются, меняется только
  // то, каким цветом красится сам бейдж.
  const GRADIENT_RED    = GS_TINT_ROWS[4][1];
  const GRADIENT_YELLOW = GS_TINT_ROWS[4][3];
  const GRADIENT_GREEN  = GS_TINT_ROWS[4][4];
  // Ранговый t (0..1, УЖЕ с учётом инверсии heatmapInvertedIds) — вынесен из heatColor
  // отдельной функцией, т.к. нужен не только для цвета бейджа, но и для зоны фильтра/
  // сортировки по цвету (см. zoneForValue ниже, п.1/п.3 брифа «Фильтр и сортировка»).
  function heatRankT(metricId: string, value: number | null): number | undefined {
    if (!heatSet.has(metricId) || value == null) return undefined;
    const vals = heatStats[metricId];
    if (!vals || vals.length === 0) return undefined;
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
    return t;
  }
  function heatColor(metricId: string, value: number | null): string | undefined {
    const t = heatRankT(metricId, value);
    if (t === undefined) return undefined;
    // Кусочная интерполяция по тем же трём опорным пастельным точкам, что и зоны
    // фильтра (0 / 0.5 / 1 = красный/жёлтый/зелёный) — только цвет непрерывный, не
    // квантованный, чтобы «выброс» плавно выделялся, как и раньше.
    return t <= 0.5
      ? mixHex(GRADIENT_RED, GRADIENT_YELLOW, t / 0.5)
      : mixHex(GRADIENT_YELLOW, GRADIENT_GREEN, (t - 0.5) / 0.5);
  }

  // Зона значения метрики (для фильтра по цвету #1 и сортировки по цвету #3): градиент —
  // квантование рангового t к ближайшему из 3 опорных цветов (см. gradientZoneFromRank);
  // пороги — дискретный «карман» между соседними порогами (resolveThresholdZone). Ни то,
  // ни другое не активно (подсветка выключена) → null, фильтр по цвету для метрики
  // недоступен (см. HighlightEditor: блок задизейблен с подсказкой).
  function zoneForValue(metricId: string, value: number | null): ZoneInfo | null {
    if (heatSet.has(metricId)) {
      const t = heatRankT(metricId, value);
      return t === undefined ? null : gradientZoneFromRank(t);
    }
    return resolveThresholdZone(value, highlights[metricId]);
  }

  // ── Фильтр по цвету/условию (#1/#2) + сортировка по цвету (#3) ──────────────────
  // Клиентские, производные от rows/metricFilters — без похода на сервер. AND между
  // всеми активными фильтрами метрик. Групповые строки: фильтруются ДЕТИ, группа
  // остаётся видимой только если хоть один ребёнок прошёл фильтр (тот же приём, что и
  // текстовый поиск в SalesReportPage). Итоговая строка (totals) в фильтрацию не
  // участвует — считается по ВСЕМ строкам среза, решение владельца (проще и честнее).
  const activeFilterEntries = Object.entries(metricFilters).filter(([, f]) => f?.colorZone || f?.condition);
  function rowPassesFilters(row: RowDeltas): boolean {
    for (const [metricId, f] of activeFilterEntries) {
      const value = row.deltas?.[metricId]?.current ?? null;
      if (f.condition && !matchesCondition(value, f.condition)) return false;
      if (f.colorZone) {
        const z = zoneForValue(metricId, value);
        if (!z || z.key !== f.colorZone) return false;
      }
    }
    return true;
  }
  const filteredRows: RowDeltas[] = activeFilterEntries.length === 0 ? rows : rows.reduce<RowDeltas[]>((acc, r) => {
    if (r.isGroup) {
      const children = (r.children ?? []).filter(rowPassesFilters);
      if (children.length) acc.push({ ...r, children });
    } else if (rowPassesFilters(r)) {
      acc.push(r);
    }
    return acc;
  }, []);

  // Только одна метрика может «сортировать по цвету» одновременно (см. SalesReportPage:
  // включение одной гасит флаг у остальных) — здесь просто берём первую активную.
  const colorSortMetricId = Object.entries(metricFilters).find(([, f]) => f?.sortByColor)?.[0];

  // При инвертированной шкале градиента (heatmapInvertedIds: «меньше = лучше») лучшая
  // зона у МЕНЬШИХ значений — если внутри зоны сортировать строго по значению убыв.
  // (буквально по брифу), «лучшее сверху» ломается ВНУТРИ зоны (там окажется значение,
  // ближайшее к худшей границе зоны, а не самое лучшее). Разворачиваем тай-брейк для
  // инвертированного градиента, чтобы «лучшее сверху» держалось и внутри зоны тоже —
  // для порогов (aboveColor всегда «лучше» по конструкции) инверсии нет, там как в брифе.
  const colorSortInverted = !!colorSortMetricId && heatSet.has(colorSortMetricId) && heatInvSet.has(colorSortMetricId);

  // Компаратор активной сортировки (метрика-колонка ИЛИ сортировка по цвету) —
  // переиспользуется на ОБОИХ уровнях группировки (задача 1566): между собой группы
  // (отделы/филиалы) сортируются по своему АГРЕГАТУ (у group-строки deltas — это и есть
  // aggregateGroupDeltas, см. applyClientGrouping в SalesReportPage), а строки внутри
  // каждой раскрытой группы — по своим значениям ТОЙ ЖЕ колонки в том же направлении (см.
  // sortGroupChildren ниже). Раньше при grouping !== 'none' компаратор был жёстко
  // no-op (return 0) — ни группы, ни тем более строки внутри группы не переупорядочивались
  // при клике на колонку.
  // null/прочерк (нет данных по метрике) — всегда в КОНЕЦ списка, независимо от
  // направления asc/desc (иначе при asc «нет данных» всплывало бы наверх).
  function compareRows(a: RowDeltas, b: RowDeltas): number {
    if (colorSortMetricId) {
      const za = zoneForValue(colorSortMetricId, a.deltas[colorSortMetricId]?.current ?? null);
      const zb = zoneForValue(colorSortMetricId, b.deltas[colorSortMetricId]?.current ?? null);
      const ra = za?.rank ?? Infinity, rb = zb?.rank ?? Infinity;
      if (ra !== rb) return ra - rb;
      // Внутри зоны — по значению (бриф п.3: «убыв.»); при инвертированном градиенте —
      // по возрастанию, чтобы «лучшее сверху» не нарушалось внутри зоны (см. коммент выше).
      const av = a.deltas[colorSortMetricId]?.current ?? -Infinity;
      const bv = b.deltas[colorSortMetricId]?.current ?? -Infinity;
      return colorSortInverted ? (av - bv) : (bv - av);
    }
    if (!sortBy) return 0;
    const av = a.deltas[sortBy]?.current ?? null;
    const bv = b.deltas[sortBy]?.current ?? null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return sortDir === 'desc' ? bv - av : av - bv;
  }

  // Рекурсивно сортирует children каждой группы ТЕМ ЖЕ компаратором/направлением, что и
  // верхний уровень — «раскрытый отдел» показывает менеджеров в том же порядке метрики.
  // «Без сортировки» (!sortBy && нет сортировки по цвету) — compareRows везде возвращает 0,
  // Array.prototype.sort стабилен (ES2019+), поэтому дефолтный порядок (из
  // applyClientGrouping) не меняется ни на одном уровне.
  function sortGroupChildren(list: RowDeltas[]): RowDeltas[] {
    return list.map(r => (r.isGroup && r.children && r.children.length > 0)
      ? { ...r, children: sortGroupChildren([...r.children].sort(compareRows)) }
      : r
    );
  }

  const sorted = sortGroupChildren([...filteredRows].sort(compareRows));

  // Нумерация строк (п.6) + счётчик для «Итого: N ...» (п.7): считаем ТОЛЬКО обычные
  // (не групповые) строки — групповые заголовки не входят, «Итого» без номера. Один и
  // тот же счёт используется и для подписи «Итого», и (отдельным счётчиком по ходу
  // рендера, см. rowNumberCounter в renderRow) для самой колонки «№» — порядок обхода
  // идентичен (sorted.map(renderRow), рекурсия в children), поэтому числа совпадают.
  function countLeafRows(list: RowDeltas[]): number {
    let n = 0;
    for (const r of list) {
      if (r.isGroup) n += countLeafRows(r.children ?? []);
      else n++;
    }
    return n;
  }
  const visibleRowCount = countLeafRows(sorted);

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
  // Колонка «№» (п.6 правок 09.07/2) — узкая sticky-колонка ПЕРЕД колонкой измерения,
  // на позиции left:0; колонка измерения сдвигается на NUMBER_COL_WIDTH (была
  // sticky left-0 напрямую классом — теперь left считается инлайн-стилем, см. ниже).
  const NUMBER_COL_WIDTH = 36;
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
      let offset = NUMBER_COL_WIDTH + (dimRef.current?.offsetWidth ?? DIMENSION_WIDTH);
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
  const hasConfigureButton = !!onMetricConfigure;

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
    if (emptyStateInfo) {
      return <ReportEmptyState info={emptyStateInfo} />;
    }
    return (
      <div className="p-6 text-center text-[var(--color-text-muted)] text-sm">
        Нет данных за выбранный период
      </div>
    );
  }

  function renderMetricCells(row: RowDeltas, clickable: boolean, stickyBg: string) {
    const alignStyle: React.CSSProperties = { textAlign: numberAlign };
    return displayMetrics.map((m, metricIdx) => {
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
      // Пороги и градиент — взаимоисключающие режимы одной и той же «подсветки значений»
      // (см. HighlightEditor: hlMode off/gradient/thresholds), поэтому для метрики активен
      // максимум один из двух источников; на случай рассинхрона данных пороги в приоритете.
      const hlColor = resolveHighlightColor(d?.current ?? null, highlights[m.id])
        ?? heatColor(m.id, d?.current ?? null);
      const accent = accentStyle(m.id);
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
        // Чистый чёрный #000 у числовых значений (п.9 правок 09.07/2) — только у САМОГО
        // значения (текущий/«Итого»), не у заголовков/подписей (--color-text там не
        // трогаем, см. остальные ячейки строки/шапки).
        if (!hlColor) return <span className="text-[var(--color-num,#000)]">{formatted}</span>;
        // py-0 (не py-0.5, правка 09.07 «строка → 30px»): вертикальный паддинг бейджа
        // поверх паддинга самой ячейки не даёт строке уложиться в 30px — бейдж и так
        // читается как пилюля за счёт rounded + горизонтального px-1.5, вертикальный
        // «воздух» ему не нужен (высота = line-height текста, как у обычного значения).
        return (
          <span
            className="inline-block px-1.5 py-0 rounded text-[var(--color-num,#000)]"
            style={{ backgroundColor: `color-mix(in srgb, ${hlColor} var(--color-highlight-pct, 68%), var(--color-mix-base, white))` }}
          >
            {formatted}
          </span>
        );
      }

      if (kinds.length > 1) {
        // full: Пред./Тек./Δ/Δ% (4); partial: Пред./Тек./Δ% (3, без абсолютной Δ) — общий
        // рендер по составу kinds (порядок задан в leafKinds), последняя под-колонка
        // всегда deltaPct (несёт pinBar).
        const lastIdx = kinds.length - 1;
        // Границы «между колонками метрик» (п.4) + акцент (п.5) — на первой под-колонке
        // (граница с соседней метрикой слева, уровень 1/2/3 — leftEdgeCls) и последней
        // (акцент справа — rightEdgeCls). Между Пред./Тек./Δ/Δ% ВНУТРИ одной метрики
        // (idx > 0) — обычная тонкая граница (уровень 1, sepCls), правка владельца 10.07:
        // раньше её не было вовсе, теперь она есть, но не толще обычной.
        const edgeCls = (idx: number) => `${idx === 0 ? leftEdgeCls(metricIdx, m) : sepCls} ${idx === lastIdx ? rightEdgeCls(m) : ''}`;
        return (
          <React.Fragment key={m.id}>
            {kinds.map((kind, idx) => {
              const p = leafProps(idx, idx === lastIdx);
              if (kind === 'current') {
                return (
                  <td
                    key={kind}
                    className={`relative text-center px-[length:var(--report-cell-px)] py-[var(--row-py)] ${edgeCls(idx)} ${cellBase} ${clickCls} ${p.className}`}
                    style={{ ...p.style, ...accent, ...alignStyle }}
                    onClick={canClick ? () => onCellClick!(row.dimensionId, row.dimensionName, m.id) : undefined}
                  >
                    <BarBg metricId={m.id} value={d?.current ?? null} />
                    <span className="relative"><HlValue value={d?.current ?? null} /></span>
                  </td>
                );
              }
              if (kind === 'comparison') {
                return (
                  <td key={kind} className={`text-center px-[length:var(--report-cell-px)] py-[var(--row-py)] ${edgeCls(idx)} ${cellBase} text-[var(--color-text-muted)] ${p.className} ${subColAnimCls(m.id, 'comparison')}`} style={{ ...p.style, ...accent, ...alignStyle }}>
                    {formatValue(d?.comparison ?? null, m.dataType, decFor(m))}
                  </td>
                );
              }
              if (kind === 'delta') {
                return (
                  <td key={kind} className={`text-center px-[length:var(--report-cell-px)] py-[var(--row-py)] ${edgeCls(idx)} ${cellBase} ${(d?.delta ?? 0) > 0 ? 'text-[var(--color-positive)]' : (d?.delta ?? 0) < 0 ? 'text-[var(--color-negative)]' : ''} ${p.className} ${subColAnimCls(m.id, 'delta')}`} style={{ ...p.style, ...accent, ...alignStyle }}>
                    {formatDelta(d?.delta ?? null, m.dataType, decFor(m))}
                  </td>
                );
              }
              // deltaPct — всегда последняя под-колонка, несёт разделитель закреплённого блока
              return (
                <td key={kind} className={`relative text-center px-[length:var(--report-cell-px)] py-[var(--row-py)] ${edgeCls(idx)} ${cellBase} ${(d?.deltaPct ?? 0) > 0 ? 'text-[var(--color-positive)]' : (d?.deltaPct ?? 0) < 0 ? 'text-[var(--color-negative)]' : ''} ${p.className} ${subColAnimCls(m.id, 'deltaPct')}`} style={{ ...p.style, ...accent, ...alignStyle }}>
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
            className={`relative text-center px-[length:var(--report-cell-px)] py-[var(--row-py)] ${leftEdgeCls(metricIdx, m)} ${rightEdgeCls(m)} ${cellBase} ${clickCls} ${p.className}`}
            style={{ ...p.style, ...accent, ...alignStyle }}
            onClick={canClick ? () => onCellClick!(row.dimensionId, row.dimensionName, m.id) : undefined}
          >
            {pinBar}
            <BarBg metricId={m.id} value={d?.current ?? null} />
            {/* Ховер-зона тултипа (пред./Δ/Δ%) — правка 09.07: раньше title сидел только на
                стрелке (span 11px), навести приходилось буквально в стрелку. Теперь title —
                на всём inline-блоке (число + стрелка), наводить можно в любую точку бейджа. */}
            <span
              className="relative inline-flex items-center justify-center"
              title={compactTooltip(d?.comparison ?? null, d?.delta ?? null, d?.deltaPct ?? null, m)}
            >
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
          className={`relative text-center px-[length:var(--report-cell-px)] py-[var(--row-py)] ${leftEdgeCls(metricIdx, m)} ${rightEdgeCls(m)} ${cellBase} ${clickCls} ${p.className}`}
          style={{ ...p.style, ...accent, ...alignStyle }}
          onClick={canClick ? () => onCellClick!(row.dimensionId, row.dimensionName, m.id) : undefined}
        >
          {pinBar}
          <BarBg metricId={m.id} value={d?.current ?? null} />
          <span className="relative"><HlValue value={d?.current ?? null} /></span>
        </td>
      );
    });
  }

  // Полная ширина строки-раскрытия: колонка «№» + колонка измерения + все листовые
  // колонки метрик (п.6: колонка «№» добавила ещё одну ведущую колонку).
  const totalLeafCols = 2 + displayMetrics.reduce((s, m) => s + colSpanFor(m.id), 0);

  // «Зебра» (правка 09.07, opt-in): счётчик визуального порядка строк через ВЕСЬ рендер
  // таблицы (включая вложенные строки групп) — не локальный индекс map()'а, который
  // сбрасывается для каждой группы. Считаем КАЖДУЮ отрисованную строку (включая
  // групповые), чтобы чередование не «съезжало» вокруг заголовков групп, но красим
  // только обычные (не групповые) строки — см. isGroupRow ниже. Объявлен здесь (а не
  // модулем/состоянием), т.к. должен просто идти по порядку одного прохода рендера.
  let zebraRowIndex = 0;
  // Нумерация строк (п.6 правок 09.07/2): сквозной счётчик через ВЕСЬ проход рендера
  // (включая рекурсию в children групп) — тот же приём, что и у zebraRowIndex выше.
  // Групповые заголовки номер не получают (см. rowNumber ниже), «Итого» — своя строка,
  // этого счётчика не касается.
  let rowNumberCounter = 0;

  function renderRow(row: RowDeltas, i: number, isChild = false): React.ReactNode {
    const isGroupRow = row.isGroup;
    const isCollapsed = collapsed.has(row.dimensionId);
    const hasChildren = isGroupRow && row.children && row.children.length > 0;
    const canClickRow = !isGroupRow && !!onRowClick;
    // Групповая строка: клик по названию сворачивает/разворачивает группу
    const canToggleRow = isGroupRow && hasChildren;
    const expandable = !isGroupRow && !!renderExpandedRow;
    const isExpanded = expandable && !!expandedRowIds?.has(row.dimensionId);
    const rowNumber = isGroupRow ? null : ++rowNumberCounter;

    // Вариант C раскраски (owners-inbox/table-colors-brief.md): по умолчанию зебра
    // убрана — все строки отчёта на bg-surface, разделитель — тонкая линия
    // --color-table-row-border, акцент при наведении — box-shadow слева
    // (.report-row:hover > td:first-child в globals.css). «Зебра» (правка 09.07) — opt-in
    // из панели «Настройки отчёта» → «Вид»: чётные (по счётчику zebraRowIndex) обычные
    // строки красятся --color-report-zebra. Групповые строки (isGroupRow) никогда не
    // полосатятся — остаются акцентной bg-surface строкой, как и раньше.
    const isZebraStripe = zebra && !isGroupRow && zebraRowIndex % 2 === 1;
    zebraRowIndex++;
    const rowBaseBg = isZebraStripe ? 'bg-[var(--color-report-zebra)]' : 'bg-[var(--color-bg-surface)]';

    // Закреплённые (pinned) колонки требуют НЕПРОЗРАЧНОГО фона независимо от зебры —
    // тот же принцип, что уже применяется к hover-фону pinned-ячеек (см. комментарий
    // «Pinned cells must use an OPAQUE hover bg» в renderMetricCells ниже): и
    // --color-bg-surface, и --color-report-zebra — сплошные цвета, поэтому подстановка
    // rowBaseBg вместо жёстко заданного bg-surface не ломает непрозрачность.
    const stickyBg = isGroupRow
      ? 'bg-[var(--color-bg-surface)]'
      : `${rowBaseBg} group-hover:bg-[var(--color-table-row-hover)]`;

    // Горизонтальный разделитель строк — часть режима «Границ» (borderMode, п.4): виден
    // в 'grid'/'horizontal' (последнее — «текущее поведение» до этой правки), скрыт в
    // 'none'. Цвет/жирность строки не меняем — эти два режима и раньше были одинаковы
    // визуально (только новый третий режим «Без границ» — новое поведение).
    const rowCls = [
      'group',
      borderMode !== 'none' ? 'border-b' : '',
      isGroupRow
        ? 'border-[var(--color-border)] bg-[var(--color-bg-surface)] font-semibold text-[var(--color-text)]'
        : `report-row border-[var(--color-table-row-border)] ${rowBaseBg}`,
    ].join(' ');

    return (
      <React.Fragment key={row.dimensionId}>
        <tr className={rowCls}>
          {/* Колонка «№» (п.6): узкая, muted, только у обычных строк — групповые
              заголовки без номера, нумерация сквозная (после сортировки/фильтра). */}
          <td
            className={`sticky z-20 ${stickyBg} px-1 py-[var(--row-py)] text-center text-[11px] text-[var(--color-text-muted)] tabular-nums border-r border-[var(--color-border)]`}
            style={{ left: 0, width: NUMBER_COL_WIDTH, minWidth: NUMBER_COL_WIDTH, maxWidth: NUMBER_COL_WIDTH }}
          >
            {rowNumber ?? ''}
          </td>
          <td
            className={`sticky z-20 ${stickyBg} w-[var(--report-dim-col)] min-w-[var(--report-dim-col)] max-w-[var(--report-dim-col)] px-[length:var(--report-cell-px)] py-[var(--row-py)] border-r border-[var(--color-border)] transition-colors ${canClickRow || canToggleRow ? 'cursor-pointer' : ''}`}
            style={{ left: NUMBER_COL_WIDTH }}
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
              {/* Имя + #id (задача 1659, case 1A аудита): на мобильном (<768px, брейкпоинт
                  соответствует --report-dim-col выше) колонка измерения узкая
                  (clamp(140px,46vw,200px)) — раньше имя и #id стояли в один ряд и id
                  «отъедал» ширину у имени, из-за чего имя обрезалось truncate. Теперь на
                  мобильном — flex-col (имя жирным первой строкой, #id мельче серым под
                  ним), на десктопе (md:) поведение НЕ меняется: та же однострочная
                  раскладка item-baseline+gap, что была всегда. */}
              <span className="min-w-0 flex-1 flex flex-col md:flex-row md:items-baseline md:gap-1.5 md:truncate">
                <span
                  className={`truncate ${isGroupRow ? 'font-semibold' : 'font-semibold md:font-normal'} ${canClickRow ? 'hover:text-[var(--color-accent)] hover:underline transition-colors' : ''}`}
                  title={row.dimensionName}
                >
                  {row.dimensionName}
                </span>
                {!isGroupRow && row.dimensionSubtitle && (
                  // Обёртка #id + иконка карточки (задача 1679, case 4В аудита): общий
                  // inline-flex, чтобы центрировать иконку по вертикали относительно СВОЕЙ
                  // строки текста, а не полагаться на baseline-выравнивание внешнего
                  // flex-контейнера (имя/#id) — на десктопе внешний контейнер выровнен по
                  // items-baseline (см. родительский span выше), у baseline своя логика для
                  // вложенных flex-контейнеров и иконка «плыла» (замечание владельца на
                  // CSS-мокапе). md:self-center выключает baseline ИМЕННО для этой обёртки,
                  // прижимая её (а значит и иконку) к центру линии имени; на мобильном
                  // (flex-col) self-* не участвует в горизонтальном позиционировании текста
                  // внутри строки — оставляем как было (без self-center) до md:.
                  <span className="inline-flex items-center gap-1 flex-shrink-0 md:self-center">
                    <span
                      className={`text-[10px] leading-tight md:text-[11px] md:leading-normal text-[var(--color-text-muted)] font-normal ${
                        onSubtitleClick ? 'hover:text-[var(--color-accent)] hover:underline transition-colors' : ''
                      }`}
                      onClick={onSubtitleClick ? (e) => { e.stopPropagation(); onSubtitleClick(row.dimensionId, row.dimensionName); } : undefined}
                      title={onSubtitleClick ? 'Открыть карточку менеджера' : undefined}
                    >
                      {row.dimensionSubtitle}
                    </span>
                    {/* Иконка «открыть карточку менеджера» — третья, ВИДИМАЯ цель клика в
                        дополнение к имени (дрилл-даун) и #id (карточка, обработчик тот же
                        onSubtitleClick). Только там, где сам onSubtitleClick передан
                        (отчёты «по менеджерам» — SalesReportPage; в отчётах по товарным
                        группам проп не передаётся, иконки не будет). В покое скрыта
                        (.hover-reveal, globals.css) — появляется по hover строки (класс
                        .group на <tr>) или фокусе; на тач/мобильном (<768px, объективно нет
                        курсорного hover) видна всегда — см. .report-card-icon override там же. */}
                    {onSubtitleClick && (
                      <button
                        onClick={e => { e.stopPropagation(); onSubtitleClick(row.dimensionId, row.dimensionName); }}
                        title="Открыть карточку менеджера"
                        aria-label="Открыть карточку менеджера"
                        className="hover-reveal report-card-icon flex-shrink-0 inline-flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
                      >
                        <IdCard size={18} />
                      </button>
                    )}
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
  // На стыке pinned→scroll границу не добавляем (симметрично needsGridDivider ниже) —
  // там уже есть свой persistent-разделитель (lastPinnedId, overlay-span в шапке/теле),
  // иначе после усиления strongLeft до 3px (правка 10.07, задача 1591) на этом стыке
  // получились бы две параллельные линии разной толщины/цвета.
  const strongLeft = new Set<string>();
  if (hasGroups) {
    let prevKey: string | undefined;
    for (const m of displayMetrics) {
      const key = pinnedMetricIds.includes(m.id) ? '__pinned__' : (groupOf.get(m.id) ?? '__ungrouped__');
      if (prevKey !== undefined && key !== prevKey && key !== '__pinned__' && prevKey !== '__pinned__') strongLeft.add(m.id);
      prevKey = key;
    }
  }
  const sepCls = 'border-l border-l-[var(--color-border)]';
  const strongGroupCls = 'border-l-[3px] border-l-[var(--color-border-strong)]';

  // ── Вертикальные границы между колонками метрик (п.4 правок 09.07, «Границы» в
  // «Вид»; пересмотрено правкой владельца 10.07 — «по сути все вертикальные границы
  // жирные»; ТРЕТЬЯ итерация 10.07 — жалоба на прод-скрин БЕЗ сравнения, где всё
  // равно полно жирных вертикалей: причиной был уровень «границы категорий каталога
  // метрик» (needsCategoryDivider/categoryOf, коммит 11cfcfd/0c0e9bb) — категория
  // (Metric.category) это внутренняя классификация справочника метрик (красит
  // заголовки в MetricPanel), у нее нет ни заголовка, ни какого-либо визуального
  // смысла ДЛЯ ПОЛЬЗОВАТЕЛЯ в самой таблице отчёта, поэтому почти каждая соседняя
  // пара метрик оказывалась «жирной» без всякой причины, которую видно на экране.
  // Уровень удалён целиком (categoryOf/needsCategoryDivider), category нигде больше
  // в ReportTable не участвует — только в MetricPanel/каталоге, структуру шапки не
  // затрагивает. Финальная (зафиксированная владельцем, msg 566/601) иерархия
  // толщины, от тонкого к жирному:
  //   1. Обычная тонкая — ВЕЗДЕ по умолчанию: между обычными метриками (каждая в 1
  //      столбец) И ВНУТРИ развёрнутой метрики между её под-колонками (Пред./Тек./
  //      Δ/Δ%, см. edgeCls в renderMetricCells) — тот же sepCls/--color-border, что
  //      и остальная сетка.
  //   2. Чуть жирней (2px --color-border-strong) — ТОЛЬКО у краёв метрики,
  //      развёрнутой больше чем на 1 столбец (режим сравнения, colSpanFor > 1): блок
  //      её под-колонок должен читаться как единое целое. Граница между двумя
  //      метриками, каждая из которых в 1 столбец, толще не становится — это
  //      обычная граница уровня 1 (см. needsStrongGridDivider ниже, логика не
  //      менялась в этой итерации).
  //   3. Жирная (3px --color-border-strong, strongGroupCls) — ТОЛЬКО края ВИДИМЫХ
  //      пользовательских групп колонок с заголовком в шапке (`columnGroups`, тип
  //      «БРОНИ И ПРОДАЖИ» — см. superSegments/hasGroups выше): это единственная
  //      группировка, у которой есть подпись в шапке и реальный смысл для
  //      пользователя. Раньше (см. WORKLOG 2026-06-29 «Облегчение таблицы») этот
  //      край, наоборот, был намеренно приглушён до hairline (sepCls) — правка
  //      владельца 10.07 отменяет то решение для этого конкретного случая.
  // Итого: в отчёте БЕЗ сравнения и БЕЗ пользовательских групп все вертикали —
  // обычные тонкие, без исключений.
  // Первая метрика в displayMetrics левую границу не получает — эту роль уже играет
  // border-r колонки измерения. На стыке pinned→scroll границу не дублируем — там уже
  // есть persistent-разделитель (lastPinnedId, overlay-span ниже), иначе будет
  // двойная линия.
  function needsGridDivider(metricIdx: number): boolean {
    if (borderMode !== 'grid' || metricIdx === 0) return false;
    const prev = displayMetrics[metricIdx - 1];
    const prevPinned = pinnedMetricIds.includes(prev.id);
    const curPinned = pinnedMetricIds.includes(displayMetrics[metricIdx].id);
    if (prevPinned && !curPinned) return false;
    return true;
  }
  // Уровень 2: граница жирнее ТОЛЬКО когда хотя бы одна из двух соседних метрик
  // развёрнута больше чем на 1 столбец (сравнение) — это её собственный внешний
  // край, отделяющий блок Пред./Тек./Δ/Δ% от соседей. Не трогали в 3-й итерации.
  function needsStrongGridDivider(metricIdx: number): boolean {
    if (!needsGridDivider(metricIdx)) return false;
    const prev = displayMetrics[metricIdx - 1];
    const cur = displayMetrics[metricIdx];
    return colSpanFor(prev.id) > 1 || colSpanFor(cur.id) > 1;
  }
  // Левая граница метрики: акцент (толще/темнее, РАБОТАЕТ В ЛЮБОМ borderMode — п.5
  // правок, «Акцент колонки» по-новому, не часть иерархии) > край пользовательской
  // группы колонок (strongLeft, 3px, уровень 3) > край развёрнутой метрики (2px,
  // уровень 2) > обычная тонкая граница между метриками (уровень 1).
  function leftEdgeCls(metricIdx: number, m: Metric): string {
    if (accentSet.has(m.id)) return 'border-l-2 border-l-[var(--color-border-strong)]';
    if (strongLeft.has(m.id)) return strongGroupCls;
    if (needsStrongGridDivider(metricIdx)) return 'border-l-2 border-l-[var(--color-border-strong)]';
    if (needsGridDivider(metricIdx)) return sepCls;
    return '';
  }
  // Правая граница метрики: только у акцентной — своя толстая граница колонки с ОБЕИХ
  // сторон, не зависящая от того, есть ли делитель у соседа справа (п.5).
  function rightEdgeCls(m: Metric): string {
    return accentSet.has(m.id) ? 'border-r-2 border-r-[var(--color-border-strong)]' : '';
  }

  // Вертикальный паддинг строки (правка владельца 09.07): «нормальная» плотность
  // должна давать РОВНО 30px высоты строки (было выше из-за py-паддингов) — при
  // line-height text-sm (14px × 1.42857 ≈ 20px) паддинг 5px сверху/снизу даёт
  // 5+20+5=30. Раньше колонка измерения (первая, «сотрудник») игнорировала density
  // и держала фикс. py-2 (16px), из-за чего реальная высота строки ВСЕГДА
  // упиралась в неё (36px), даже в compact — теперь колонка измерения тоже на
  // --row-py (см. renderRow), поэтому compact/relaxed стали настоящими, а не
  // визуально одинаковыми с normal.
  //
  // «Масштаб таблиц» (бриф 09.07, п.3): basePy умножается на tableScale — line-height
  // уже масштабируется автоматически вместе с fontSize (Tailwind text-sm задаёт его
  // унитарным множителем, не фикс. px — см. --text-sm--line-height), поэтому умножение
  // ОБОИХ слагаемых (fontSize и basePy) на один и тот же tableScale даёт РОВНО
  // 30px×tableScale итоговой высоты строки — то есть настоящее пропорциональное
  // масштабирование от базовых 30px/100%, а не только шрифта.
  const basePy = density === 'compact' ? 2 : density === 'relaxed' ? 14 : 5;
  // Мобильный доп.-множитель (задача 1659, case 1A аудита): --report-mobile-scale = 1 на
  // десктопе (≥768px, globals.css) — calc() схлопывается к прежнему значению, на
  // мобильном ужимает паддинг ПОВЕРХ пользовательского tableScale (тот же приём, что и
  // у fontSize таблицы ниже — см. рендер <table>).
  const rowPy = `calc(${basePy * tableScale}px * var(--report-mobile-scale, 1))`;

  // ── Группировка «Итого» — вертикальная таблица (правка собрания 09.07/2) ────────
  // Раньше «Итого» рендерился как ОДНА строка со всеми метриками во всю ширину
  // (через обычный renderRow/renderMetricCells) — при десятках метрик строка
  // превращалась в бесконечную горизонтальную простыню. Вместо этого: колонка
  // «Метрика» (название целиком, без обрезки) + колонка «Значение» (или Пред./Тек./
  // Δ/Δ% — наш порядок, если хотя бы одна метрика в режиме сравнения). Подсветка/
  // бейджи values — тот же resolveHighlightColor/heatColor, что и в обычной таблице;
  // сортировка и нумерация тут не нужны (сортировать/нумеровать одну сводную строку
  // не имеет смысла — п. брифа).
  if (grouping === 'total') {
    const totalRow = sorted[0];
    const hasAnyComparison = displayMetrics.some(m => leafKinds(resolveMode(m.id)).length > 1);
    return (
      <div className="overflow-auto h-full bg-[var(--color-bg-surface)]" style={{ fontSize: `${14 * tableScale}px` }}>
        <div className="max-w-3xl mx-auto p-5 sm:p-7">
          {!totalRow ? (
            <div className="text-sm text-[var(--color-text-muted)] text-center py-10">Нет данных</div>
          ) : (
            <table className="w-full text-sm border border-[var(--color-border)] rounded-xl overflow-hidden border-collapse">
              <thead>
                <tr className="bg-[var(--color-table-header)] text-[var(--color-text-muted)] text-[11px] font-bold uppercase tracking-wide">
                  <th className="text-left px-4 py-2.5 border-b border-[var(--color-border)]">Метрика</th>
                  {hasAnyComparison && <th className="text-center px-3 py-2.5 border-b border-l border-[var(--color-border)] w-28">Пред.</th>}
                  <th className="text-center px-3 py-2.5 border-b border-l border-[var(--color-border)] w-28">Тек.</th>
                  {hasAnyComparison && <th className="text-center px-3 py-2.5 border-b border-l border-[var(--color-border)] w-24">Δ</th>}
                  {hasAnyComparison && <th className="text-center px-3 py-2.5 border-b border-l border-[var(--color-border)] w-24">Δ%</th>}
                </tr>
              </thead>
              <tbody>
                {displayMetrics.map((m, idx) => {
                  const d = totalRow.deltas?.[m.id];
                  const mode = resolveMode(m.id);
                  const kinds = leafKinds(mode);
                  const hlColor = resolveHighlightColor(d?.current ?? null, highlights[m.id]) ?? heatColor(m.id, d?.current ?? null);
                  const current = formatValue(d?.current ?? null, m.dataType, decFor(m));
                  const isLastRow = idx === displayMetrics.length - 1;
                  const rowBorder = isLastRow ? '' : 'border-b border-[var(--color-border)]';
                  const valueCell = (
                    <span className="relative inline-flex items-center justify-center gap-1">
                      {!hlColor ? (
                        <span className="text-[var(--color-num,#000)]">{current}</span>
                      ) : (
                        <span
                          className="inline-block px-1.5 py-0 rounded text-[var(--color-num,#000)]"
                          style={{ backgroundColor: `color-mix(in srgb, ${hlColor} var(--color-highlight-pct, 68%), var(--color-mix-base, white))` }}
                        >
                          {current}
                        </span>
                      )}
                      {mode === 'compact' && (
                        <span
                          className="w-4 flex-shrink-0 flex items-center justify-center"
                          title={compactTooltip(d?.comparison ?? null, d?.delta ?? null, d?.deltaPct ?? null, m)}
                        >
                          <TrendArrow
                            deltaPct={d?.deltaPct ?? null}
                            delta={d?.delta ?? null}
                            metric={m}
                            threshold={thresholdFor(m, metricThresholdOverrides)}
                          />
                        </span>
                      )}
                    </span>
                  );
                  return (
                    <tr key={m.id} className={rowBorder}>
                      <td className="px-4 py-2.5 font-medium text-[var(--color-text)] whitespace-nowrap">{m.nameRu}</td>
                      {hasAnyComparison && (
                        <td className="text-center px-3 py-2.5 border-l border-[var(--color-border)] tabular-nums text-[var(--color-text-muted)]">
                          {kinds.includes('comparison') ? formatValue(d?.comparison ?? null, m.dataType, decFor(m)) : '—'}
                        </td>
                      )}
                      <td className="text-center px-3 py-2.5 border-l border-[var(--color-border)] tabular-nums">{valueCell}</td>
                      {hasAnyComparison && (
                        <td className={`text-center px-3 py-2.5 border-l border-[var(--color-border)] tabular-nums ${kinds.includes('delta') ? ((d?.delta ?? 0) > 0 ? 'text-[var(--color-positive)]' : (d?.delta ?? 0) < 0 ? 'text-[var(--color-negative)]' : '') : 'text-[var(--color-text-muted)]'}`}>
                          {kinds.includes('delta') ? formatDelta(d?.delta ?? null, m.dataType, decFor(m)) : '—'}
                        </td>
                      )}
                      {hasAnyComparison && (
                        <td className={`text-center px-3 py-2.5 border-l border-[var(--color-border)] tabular-nums ${kinds.includes('deltaPct') ? ((d?.deltaPct ?? 0) > 0 ? 'text-[var(--color-positive)]' : (d?.deltaPct ?? 0) < 0 ? 'text-[var(--color-negative)]' : '') : 'text-[var(--color-text-muted)]'}`}>
                            {kinds.includes('deltaPct') ? formatDeltaPct(d?.deltaPct ?? null) : '—'}
                          </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-auto h-full bg-[var(--color-bg-surface)]">
      <table className="w-full text-sm border-collapse" style={{ fontSize: `calc(${14 * tableScale}px * var(--report-mobile-scale, 1))`, ['--row-py' as string]: rowPy } as React.CSSProperties}>
        <thead className="report-thead sticky top-0 z-30 bg-[var(--color-table-header)]">
          {hasGroups && (
            <tr>
              <th className="sticky z-40 bg-[var(--color-table-header)] border-b border-r border-[var(--color-border)]" style={{ left: 0, width: NUMBER_COL_WIDTH, minWidth: NUMBER_COL_WIDTH, maxWidth: NUMBER_COL_WIDTH }} />
              <th className="sticky z-40 bg-[var(--color-table-header)] border-b border-r border-[var(--color-border)] w-[var(--report-dim-col)] min-w-[var(--report-dim-col)] max-w-[var(--report-dim-col)]" style={{ left: NUMBER_COL_WIDTH }} />
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
                  className={`text-center px-2 py-1.5 text-xs font-bold uppercase tracking-wider border-b border-[var(--color-border)] bg-[var(--color-table-header)] ${seg.name ? 'text-[var(--color-text)] border-l-[3px] border-l-[var(--color-border-strong)] border-r-[3px] border-r-[var(--color-border-strong)]' : 'text-transparent'}`}
                >
                  {seg.name ?? ' '}
                </th>
              ))}
            </tr>
          )}
          <tr>
            {/* Заголовок колонки «№» (п.6) — узкая sticky-колонка перед измерением. */}
            <th
              className="sticky z-40 bg-[var(--color-table-header)] text-center px-1 py-2.5 text-[11px] font-medium text-[var(--color-text-muted)] border-b border-r border-[var(--color-border)]"
              style={{ left: 0, width: NUMBER_COL_WIDTH, minWidth: NUMBER_COL_WIDTH, maxWidth: NUMBER_COL_WIDTH }}
            >
              №
            </th>
            <th ref={dimRef} className="sticky z-40 bg-[var(--color-table-header)] text-left px-2 py-2.5 font-medium text-[var(--color-text)] border-b border-r border-[var(--color-border)] w-[var(--report-dim-col)] min-w-[var(--report-dim-col)] max-w-[var(--report-dim-col)]" style={{ left: NUMBER_COL_WIDTH }}>
              <div className="flex items-center justify-between gap-2">
                {/* Левый край текста заголовка — на той же вертикали, что и значения строк:
                    px-2 (8px) + резервный слот w-5 (20px, как у спейсера/шеврона в строках)
                    + gap-1 (4px) = 32px, см. renderRow. */}
                <span className="flex items-center gap-1">
                  <span className="w-5 flex-shrink-0" aria-hidden />
                  {dimensionLabel}
                </span>
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
            {displayMetrics.map((m, metricIdx) => {
              const mode = resolveMode(m.id);
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
                  className={`relative text-center px-3 py-2 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] bg-[var(--color-table-header)] group ${leftEdgeCls(metricIdx, m)} ${rightEdgeCls(m)} ${isPinnedCol ? 'sticky z-40' : ''} ${m.id === lastPinnedId ? 'border-r border-r-[var(--color-border)]' : ''} ${draggedMetricId === m.id ? 'opacity-40' : ''} ${dragOverMetricId === m.id && draggedMetricId !== m.id ? 'border-l-2 border-l-[var(--color-accent)]' : ''}`}
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
                    {/* Маркер активного фильтра по цвету/условию (не сортировки — она строк не
                        убирает) — иначе непонятно, почему в колонке/таблице вдруг мало строк. */}
                    {(metricFilters[m.id]?.colorZone || metricFilters[m.id]?.condition) && (
                      <span
                        title="По этой метрике активен фильтр — часть строк скрыта"
                        className="text-[var(--color-accent)] w-[12px] flex-shrink-0 mt-0.5"
                      >
                        <Filter size={11} />
                      </span>
                    )}
                  </div>
                  {/* Полоска-сегмент под названием метрики (metric-header-brief.md): слева —
                      циклический переключатель режима (full→partial→compact→current→full),
                      по центру — драг-зона (тянется, растягивается только она при раскрытом
                      сравнении), справа — шестерёнка настроек. Видна только по hover на <th>
                      (класс .group уже на <th> выше), на таче — всегда (hover-reveal). */}
                  {(onMetricQuickCompareToggle || hasConfigureButton || onMetricReorder) && (
                    <div
                      className={`hover-reveal mt-1 flex items-stretch h-5 rounded-[7px] border border-[var(--color-border)] bg-[var(--color-bg-surface)] overflow-hidden shadow-[0_1px_2px_rgba(33,37,41,0.06)] mx-auto ${span > 1 ? 'w-full' : 'w-[92px]'}`}
                      onClick={e => e.stopPropagation()}
                    >
                      {onMetricQuickCompareToggle && (
                        <button
                          onClick={e => { e.stopPropagation(); onMetricQuickCompareToggle(m.id); }}
                          className={`w-6 flex-shrink-0 flex items-center justify-center border-r border-[var(--color-border)] transition-colors ${
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
                          className="flex-1 min-w-[28px] flex items-center justify-center cursor-grab bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] transition-colors"
                          title="Перетащить колонку"
                        >
                          <GripVertical size={12} />
                        </span>
                      ) : (
                        <span className="flex-1 min-w-[28px] bg-[var(--color-bg)]" />
                      )}
                      {/* Шестерёнка ведёт сразу в панель настроек метрики (HighlightEditor) —
                          промежуточное контекстное меню (MetricMenu) упразднено 09.07, ←/→/
                          «Убрать» переехали в саму панель настроек. */}
                      {onMetricConfigure && (
                        <button
                          onClick={e => { e.stopPropagation(); onMetricConfigure(m.id); }}
                          className="w-6 flex-shrink-0 flex items-center justify-center border-l border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition-colors"
                          title="Настройки метрики"
                        >
                          <Settings size={12} />
                        </button>
                      )}
                    </div>
                  )}
                </th>
              );
            })}
          </tr>

          {hasAnyWideMode && (
            <tr className="bg-[var(--color-table-header)]">
              <th className="sticky z-40 bg-[var(--color-table-header)] border-b border-r border-[var(--color-border)]" style={{ left: 0, width: NUMBER_COL_WIDTH, minWidth: NUMBER_COL_WIDTH, maxWidth: NUMBER_COL_WIDTH }} />
              <th className="sticky z-40 bg-[var(--color-table-header)] border-b border-r border-[var(--color-border)] w-[var(--report-dim-col)] min-w-[var(--report-dim-col)] max-w-[var(--report-dim-col)]" style={{ left: NUMBER_COL_WIDTH }} />
              {displayMetrics.map((m, metricIdx) => {
                const kinds = leafKinds(visualMode(m.id));
                const isPinned = pinnedMetricIds.includes(m.id) && isMeasured(m.id);
                const s = { minWidth: METRIC_COL_WIDTH };
                const sub = (i: number, base: string) => {
                  const cls = `bg-[var(--color-table-header)] ${isPinned ? 'sticky z-40' : ''} ${base}`;
                  const style = { ...(isPinned ? { ...s, left: leafLeft(m.id, i) } : s), ...colorizeStyle(m), ...accentStyle(m.id) };
                  return { cls, style };
                };
                const edgeBase = (idx: number, lastIdx: number) => `${idx === 0 ? leftEdgeCls(metricIdx, m) : sepCls} ${idx === lastIdx ? rightEdgeCls(m) : ''}`;
                if (kinds.length > 1) {
                  const lastIdx = kinds.length - 1;
                  const KIND_LABEL: Record<string, string> = { current: 'Тек.', comparison: 'Пред.', delta: 'Δ', deltaPct: 'Δ%' };
                  return (
                    <React.Fragment key={m.id}>
                      {kinds.map((kind, idx) => {
                        const sb = sub(idx, edgeBase(idx, lastIdx));
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
                const one = sub(0, edgeBase(0, 0));
                return <th key={m.id} ref={setLeafRef(`${m.id}:0`)} className={`relative border-b border-[var(--color-border)] ${one.cls}`} style={one.style}>{m.id === lastPinnedId && <span className="absolute top-0 bottom-0 right-0 w-px bg-[var(--color-border)] pointer-events-none z-50" />}</th>;
              })}
            </tr>
          )}
        </thead>
        <tbody>
          {sorted.map((row, i) => renderRow(row, i))}

          {/* grouping === 'total' — ранний return выше, сюда рендер не доходит */}
          {totals && (
            <tr className="font-semibold text-[var(--color-text)]">
              {/* Колонка «№» строки «Итого» — без номера (п.6), но ячейка нужна для
                  сохранения сетки колонок под sticky-смещения метрик. */}
              <td
                className="sticky bottom-0 z-30 border-r border-[var(--color-border)] border-t-2 border-t-[var(--color-accent)]"
                style={{ left: 0, width: NUMBER_COL_WIDTH, minWidth: NUMBER_COL_WIDTH, maxWidth: NUMBER_COL_WIDTH, backgroundColor: TOTALS_BG }}
              />
              <td
                className="sticky bottom-0 z-30 px-[length:var(--report-cell-px)] py-[var(--row-py)] border-r border-[var(--color-border)] border-t-2 border-t-[var(--color-accent)] w-[var(--report-dim-col)] min-w-[var(--report-dim-col)] max-w-[var(--report-dim-col)] uppercase tracking-wider text-[12px]"
                style={{ left: NUMBER_COL_WIDTH, backgroundColor: TOTALS_BG }}
              >
                {/* Тот же резервный слот (w-5) + gap-1, что у заголовка и строк данных — акцентная
                    плашка теперь центрирована внутри слота, а не сдвигает текст «Итого». Текст
                    строки «Итого» (п.7 правок 09.07/2): «Итого: N <измерение>» — N видимых строк
                    (после сортировки/фильтра, без учёта групповых заголовков), склонение — см.
                    dimensionCountLabel. */}
                <span className="flex items-center gap-1">
                  <span className="w-5 flex-shrink-0 flex items-center justify-center">
                    <span className="w-1 h-4 rounded-full bg-[var(--color-accent)]" />
                  </span>
                  {`Итого: ${dimensionCountLabel(dimensionLabel, visibleRowCount)}`}
                </span>
              </td>
              {displayMetrics.map((m, metricIdx) => {
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
                const edgeBase = (idx: number, lastIdx: number) => `${idx === 0 ? leftEdgeCls(metricIdx, m) : sepCls} ${idx === lastIdx ? rightEdgeCls(m) : ''}`;
                const pinSep = m.id === lastPinnedId
                  ? <span className="absolute top-0 bottom-0 right-0 w-px bg-[var(--color-border)] pointer-events-none z-50" />
                  : null;
                // Значения «Итого» по этой метрике (правка 09.07: раньше comparison/delta/
                // deltaPct тут были жёстко «—» — итог по прошлому периоду не агрегировался
                // вообще, см. route.ts). Считаются тем же способом, что и «Тек.» (computeTotals),
                // просто по comparison-строкам — корректно и для несуммируемых метрик (%/CR).
                const tv = totals[m.id];
                if (kinds.length > 1) {
                  const lastIdx = kinds.length - 1;
                  return (
                    <React.Fragment key={m.id}>
                      {kinds.map((kind, idx) => {
                        const sb = sub(idx, edgeBase(idx, lastIdx));
                        const isLast = idx === lastIdx;
                        const animCls = idx === 0 ? '' : subColAnimCls(m.id, kind as 'comparison' | 'delta' | 'deltaPct');
                        if (kind === 'current') {
                          return (
                            <td key={kind} className={`text-center px-[length:var(--report-cell-px)] py-[var(--row-py)] tabular-nums text-[var(--color-num,#000)] ${clickCls} ${sb.cls}`} style={sb.style} onClick={handleClick}>
                              {formatValue(tv?.current ?? null, m.dataType, decFor(m))}
                            </td>
                          );
                        }
                        if (kind === 'comparison') {
                          return (
                            <td key={kind} className={`text-center px-[length:var(--report-cell-px)] py-[var(--row-py)] tabular-nums text-[var(--color-text-muted)] ${sb.cls} ${animCls}`} style={sb.style}>
                              {formatValue(tv?.comparison ?? null, m.dataType, decFor(m))}
                            </td>
                          );
                        }
                        if (kind === 'delta') {
                          return (
                            <td key={kind} className={`text-center px-[length:var(--report-cell-px)] py-[var(--row-py)] tabular-nums ${(tv?.delta ?? 0) > 0 ? 'text-[var(--color-positive)]' : (tv?.delta ?? 0) < 0 ? 'text-[var(--color-negative)]' : ''} ${sb.cls} ${animCls}`} style={sb.style}>
                              {formatDelta(tv?.delta ?? null, m.dataType, decFor(m))}
                            </td>
                          );
                        }
                        // deltaPct — всегда последняя под-колонка, несёт разделитель pinned-блока
                        return (
                          <td key={kind} className={`relative text-center px-[length:var(--report-cell-px)] py-[var(--row-py)] tabular-nums ${(tv?.deltaPct ?? 0) > 0 ? 'text-[var(--color-positive)]' : (tv?.deltaPct ?? 0) < 0 ? 'text-[var(--color-negative)]' : ''} ${sb.cls} ${animCls}`} style={sb.style}>
                            {formatDeltaPct(tv?.deltaPct ?? null)}{isLast ? pinSep : null}
                          </td>
                        );
                      })}
                    </React.Fragment>
                  );
                }
                const one = sub(0, edgeBase(0, 0));
                return (
                  <td key={m.id} className={`relative text-center px-3 py-[var(--row-py)] tabular-nums text-[var(--color-num,#000)] ${clickCls} ${one.cls}`} style={one.style} onClick={handleClick}>
                    {formatValue(tv?.current ?? null, m.dataType, decFor(m))}
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
