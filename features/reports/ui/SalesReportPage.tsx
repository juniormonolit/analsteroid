'use client';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { defaultPeriod, defaultComparison } from '@/lib/period';
import { FilterBar } from './FilterBar';
import { ReportToolbar } from './ReportToolbar';
import { ReportTable } from './ReportTable';
import { MetricPanel, getMetricPanelWidth } from './MetricPanel';
import { ViewSettings, loadViewPrefs, saveViewPrefs, DEFAULT_VIEW_PREFS, type ViewPrefs } from './ViewSettings';
import { HighlightEditor } from './HighlightEditor';
import { SaveReportModal } from './SaveReportModal';
import { DrilldownDrawer } from './DrilldownDrawer';
import type { DrilldownTarget } from './DrilldownDrawer';
import { ManagerCardPanel } from '@/features/manager-card/ui/ManagerCardPanel';
import { ComparisonPanel } from './ComparisonPanel';
import { computeCalculated } from '@/features/reports/engine/calculated';
import type { DealScope, ClientType, Grouping, Metric, ProductGroupMode, ComparisonDisplay, BorderMode } from '@/lib/metrics/types';
import type { DateRange } from '@/lib/period';
import type { MetricHighlightConfig, SavedReport, SavedReportInput } from '@/lib/saved-reports/types';
import { resolveRelativePeriod, resolveComparison } from '@/lib/saved-reports/period';
import type { MetricFilters, MetricConditionFilter } from '@/lib/reports/metricFilter';
import { type SourceDimension, type DrilldownDimension } from '@/lib/marketing/dimensions';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { branchLabel } from '@/lib/org/branchLabel';
import { isHeatmapEnabled, isRelativeDataType, toggleHeatmap } from '@/lib/metrics/heatmapDefault';
import { useTableScale } from '@/lib/hooks/useTableScale';

type Deltas = Record<string, { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null }>;

type MergedRow = {
  dimensionId: string;
  dimensionName: string;
  dimensionSubtitle?: string;
  teamId: string | null;
  teamName: string | null;
  branchName?: string | null;
  deltas: Deltas;
};

type GroupedMergedRow = MergedRow & { isGroup?: boolean; children?: MergedRow[]; };

// Честная агрегация группы: collected/external суммируются, calculated (конверсии,
// средние чеки, % плана) пересчитываются по своей формуле от СУММ — отдельно для
// текущего и сравнительного периодов. Просто складывать проценты нельзя.
function aggregateGroupDeltas(members: MergedRow[], metrics: Metric[]): Deltas {
  const ids = new Set<string>();
  for (const r of members) for (const id of Object.keys(r.deltas)) ids.add(id);
  const byId = new Map(metrics.map(m => [m.id, m]));

  const sumsCur: Record<string, number | null> = {};
  const sumsCmp: Record<string, number | null> = {};
  for (const id of ids) {
    if (byId.get(id)?.metricType === 'calculated') continue;
    let cur: number | null = null, cmp: number | null = null;
    for (const r of members) {
      const d = r.deltas[id];
      if (!d) continue;
      if (d.current !== null) cur = (cur ?? 0) + d.current;
      if (d.comparison !== null) cmp = (cmp ?? 0) + d.comparison;
    }
    sumsCur[id] = cur;
    sumsCmp[id] = cmp;
  }

  const calc = metrics.filter(m => m.metricType === 'calculated' && ids.has(m.id));
  const cur = computeCalculated(sumsCur, calc);
  const cmp = computeCalculated(sumsCmp, calc);

  const deltas: Deltas = {};
  for (const id of ids) {
    const c = cur[id] ?? null, p = cmp[id] ?? null;
    const delta = c !== null && p !== null ? c - p : null;
    const deltaPct = delta === null || p === null || p === 0 ? null : (delta / p) * 100;
    deltas[id] = { current: c, comparison: p, delta, deltaPct };
  }
  return deltas;
}

function applyClientGrouping(rows: MergedRow[], grouping: Grouping, metrics: Metric[]): GroupedMergedRow[] {
  if (grouping === 'none') return rows;

  if (grouping === 'total') {
    return [{
      dimensionId: '__total__', dimensionName: 'Итого', teamId: null, teamName: null,
      deltas: aggregateGroupDeltas(rows, metrics), isGroup: true, children: rows,
    }];
  }

  if (grouping === 'branch') {
    // Костыль сравнения отделов по городам: город (филиал) → АГРЕГИРОВАННЫЕ строки
    // отделов (не менеджеры). Всё, что не Москва и не Краснодар, — СПб (правило
    // заказчика; в byManagers оно же — фолбэк для менеджеров без филиала).
    const order: string[] = [];
    const groups = new Map<string, MergedRow[]>();
    for (const row of rows) {
      const key = row.branchName ?? 'СПб';
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key)!.push(row);
    }

    return order.map(branch => {
      const members = groups.get(branch)!;
      const teamOrder: string[] = [];
      const byTeam = new Map<string, MergedRow[]>();
      for (const row of members) {
        const tk = row.teamId ?? '__no_team__';
        if (!byTeam.has(tk)) { byTeam.set(tk, []); teamOrder.push(tk); }
        byTeam.get(tk)!.push(row);
      }
      const teamRows: MergedRow[] = teamOrder.map(tk => {
        const tm = byTeam.get(tk)!;
        const teamName = tm[0]?.teamName ?? 'Без отдела';
        return {
          dimensionId: `__team__${tk}`,
          dimensionName: teamName,
          dimensionSubtitle: `${tm.length} чел.`,
          teamId: tk,
          teamName,
          branchName: branch,
          deltas: aggregateGroupDeltas(tm, metrics),
        };
      });
      return {
        dimensionId: `__branch__${branch}`,
        // Display-слой (п.5 правок 09.07/2): «СПб»→«Санкт-Петербург» и т.п. — ключ
        // dimensionId/branchName остаётся сырым (маршрутизация дрилл-дауна/фильтры).
        dimensionName: branchLabel(branch),
        teamId: null,
        teamName: null,
        branchName: branch,
        deltas: aggregateGroupDeltas(members, metrics),
        isGroup: true,
        children: teamRows,
      };
    });
  }

  // grouping === 'team'
  const order: string[] = [];
  const groups = new Map<string, MergedRow[]>();
  for (const row of rows) {
    const key = row.teamId ?? '__no_team__';
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(row);
  }

  return order.map(key => {
    const members = groups.get(key)!;
    const name = members[0]?.teamName ?? 'Без отдела';
    return {
      dimensionId: `__team__${key}`,
      dimensionName: name,
      teamId: key,
      teamName: name,
      deltas: aggregateGroupDeltas(members, metrics),
      isGroup: true,
      children: members,
    };
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
  const isMobile = useIsMobile();

  // Пункт 3а спеки: тумблер «Обычная/Про» из ЛК. Пока грузится/не резолвится — не
  // урезаем UI (fail-open к «Про»), чтобы не мигать тулбаром на первом рендере.
  const { data: uiModeData } = useQuery<{ uiMode: 'basic' | 'pro' }>({
    queryKey: ['ui-mode'],
    queryFn: async () => {
      const res = await fetch('/api/me/ui-mode');
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
    staleTime: 60_000,
  });
  const isPro = uiModeData ? uiModeData.uiMode !== 'basic' : true;
  const [period, setPeriod]             = useState<DateRange>(defaultPeriod);
  // Дефолт до появления сохранённого пресета (by-managers/by-product-groups) — сам
  // defaultPeriod() по конструкции всегда календарный объект («этот месяц»/«прошлый
  // месяц целиком» 1-го числа), поэтому и сравнение по умолчанию календарное
  // (задача 10.07), а не хвост — см. lib/period::defaultComparison.
  const [comparison, setComparison]     = useState<DateRange>(defaultComparison);
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
  // Карточка менеджера (клик по #логину в отчёте «по менеджерам», MVP экрана 1
  // мокапа manager-card-mock.html) — независимая от drilldown правая панель.
  const [managerCard, setManagerCard]   = useState<{ id: string; name: string } | null>(null);
  // Режим «Сравнение» (п. Н2 спеки): выбор сущностей живёт в состоянии страницы (не в
  // БД) — так он переживает закрытие/повторное открытие слайдера в рамках сессии.
  const [showComparison, setShowComparison] = useState(false);
  const [compareIds, setCompareIds]     = useState<string[]>([]);
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
  const [colorizeMetrics, setColorizeMetrics] = useState(false);
  // «Зебра» (правка владельца 09.07): лёгкая полосатость чётных строк ReportTable,
  // по умолчанию выкл (текущее поведение, вариант C без зебры).
  const [zebra, setZebra] = useState(false);
  // «Границы» (п.4 правок 09.07, встреча вечер): дефолт — полная сетка (новое поведение,
  // до этой правки вертикальных границ между метриками не было вовсе).
  const [borderMode, setBorderMode] = useState<BorderMode>('grid');
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
  // Фильтр по цвету/условию + сортировка по цвету (правка владельца 09.07, панель
  // настроек метрики → «Фильтр и сортировка»). Намеренно СЕССИОННОЕ состояние — не
  // персистится в SavedReport (меньше риска на первый заход), сбрасывается сменой отчёта.
  const [metricFilters, setMetricFilters] = useState<MetricFilters>({});
  const [columnGroups, setColumnGroups] = useState<{ name: string; metricIds: string[] }[]>([]);
  const [viewPrefs, setViewPrefs] = useState<ViewPrefs>(DEFAULT_VIEW_PREFS);

  useEffect(() => { setViewPrefs(loadViewPrefs()); }, []);
  function updateViewPrefs(p: ViewPrefs) { setViewPrefs(p); saveViewPrefs(p); }

  // «Масштаб таблиц» ЛК (бриф 09.07, п.3): глобальный per-user множитель, применяется
  // ко всем таблицам отчёта (основная/дрилл-даун/сделки) — НЕ per-report настройка,
  // источник — users.table_scale (см. ViewSettings.tsx — «Размер шрифта» убран оттуда).
  const { tableScaleMult } = useTableScale();

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
    setColorizeMetrics(preset.colorizeMetrics ?? false);
    setZebra(preset.zebra ?? false);
    setBorderMode(preset.borderMode ?? 'grid');
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

  // Сравнение при смене периода теперь считает PeriodRangeControls (FilterBar.tsx —
  // задача 10.07: быстрый пресет → календарный шаг назад, ручной диапазон → хвост
  // той же длины, как раньше), через onComparisonChange={setComparison} ниже.
  const handlePeriodChange = useCallback((p: DateRange) => {
    setPeriod(p);
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

  // Немедленная (без «Сохранить», без закрытия панели) очистка report-scope порогового
  // конфига метрики — вызывается HighlightEditor при переключении радиокнопки подсветки
  // на «Выключена»/«Градиент», пока пользователь ещё может продолжать редактировать
  // остальные настройки метрики в той же панели. Убирает старую асимметрию: heatmap-флаг
  // гасится мгновенно (onHeatmapToggle), а пороги должны гаситься так же мгновенно, а не
  // только по клику «Сохранить».
  function handleThresholdsClear() {
    if (!configuringMetricId) return;
    setHighlights(prev => {
      if (!(configuringMetricId in prev)) return prev;
      const next = { ...prev };
      delete next[configuringMetricId];
      return next;
    });
  }

  async function handleGlobalHighlight(metricId: string, config: MetricHighlightConfig | null) {
    await fetch(`/api/user-highlights/${metricId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
  }

  // Возвращает результат вызывающей модалке — раньше ошибка (403/409/500) молча
  // проглатывалась, модалка закрывалась как будто всё сохранилось (баг 09.07:
  // «не работает сохранение в Отчёты Стаса/Роп монитор» — сервер падал на конфликте
  // имён, а фронтенд об этом не узнавал). Теперь модалка сама решает, закрываться
  // ей или показать ошибку и остаться открытой.
  //
  // Три режима (правка владельца 10.07, диалог конфликта имён в SaveReportModal):
  // - 'create' — обычное сохранение (нет конфликта имени) — POST, как раньше.
  // - 'update' — «Перезаписать» из диалога конфликта ИЛИ тихое пересохранение уже
  //   открытого отчёта (currentReportId) без конфликта — PUT по id, id сохраняется.
  // - 'copy' — «Сохранить копию» из диалога — POST с forceCopy: сервер вставляет
  //   новую строку, при совпадении имени В ТОМ ЖЕ скоупе сам подбирает свободное имя.
  async function handleSaveReport(
    input: SavedReportInput,
    opts: { mode: 'create' | 'update' | 'copy'; targetId?: string }
  ): Promise<{ ok: boolean; error?: string; name?: string }> {
    try {
      const res = opts.mode === 'update'
        ? await fetch(`/api/saved-reports/${opts.targetId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          })
        : await fetch('/api/saved-reports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts.mode === 'copy' ? { ...input, forceCopy: true } : input),
          });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { ok: false, error: data.error ?? 'Не удалось сохранить отчёт' };
      }
      const data = await res.json().catch(() => ({}));
      setShowSaveModal(false);
      return { ok: true, name: data.name };
    } catch {
      return { ok: false, error: 'Сетевая ошибка при сохранении' };
    }
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
    const grouped = applyClientGrouping(data?.rows ?? [], grouping, catalogMetrics);
    if (!search.trim()) return grouped;
    const q = search.trim().toLowerCase();
    // Поиск и по короткому логину менеджера (п.3 правок 09.07/2): dimensionSubtitle
    // хранит short_login ТОЛЬКО в отчёте по менеджерам (см. byManagers.ts) — для
    // прочих отчётов это поле либо не задано, либо содержит другой текст, не мешает.
    const matchesSearch = (r: { dimensionName: string; dimensionSubtitle?: string }) =>
      r.dimensionName.toLowerCase().includes(q) || (r.dimensionSubtitle ?? '').toLowerCase().includes(q);
    if (grouping === 'none') {
      return grouped.filter(matchesSearch);
    }
    return grouped
      .map(r => {
        if (!r.isGroup) return matchesSearch(r) ? r : null;
        const filteredChildren = (r.children ?? []).filter(matchesSearch);
        if (filteredChildren.length === 0) return null;
        return { ...r, children: filteredChildren };
      })
      .filter(Boolean) as typeof grouped;
  }, [data?.rows, grouping, search, catalogMetrics]);

  const handleRowClick = useCallback(
    (id: string, name: string) => {
      // Агрегированные строки отделов внутри филиала → сделки отдела
      if (id.startsWith('__team__')) setDrilldown({ id: id.slice('__team__'.length), name, kind: 'team' });
      else if (id.startsWith('__branch__')) setDrilldown({ id: id.slice('__branch__'.length), name, kind: 'branch' });
      else setDrilldown({ id, name });
    },
    []
  );

  // Клик по #логину менеджера (dimensionSubtitle) — только в отчёте «по менеджерам»
  // (в остальных отчётах ReportTable либо не получает onSubtitleClick вовсе, либо
  // dimensionSubtitle означает что-то другое — см. проп в ReportTable.tsx).
  const handleSubtitleClick = useCallback(
    (id: string, name: string) => setManagerCard({ id, name }),
    []
  );

  const handleCellClick = useCallback(
    (id: string, name: string, metricId: string) => {
      const m = catalogMetrics.find((x: { id: string }) => x.id === metricId)
        ?? availableMetrics.find((x: { id: string }) => x.id === metricId);
      // Групповые строки и «Итого» открывают плоский список сделок всего среза
      if (id === '__total__') {
        setDrilldown({ id: '__all__', name: 'Итого', metricId, metricName: m?.nameRu, kind: 'total' });
      } else if (id.startsWith('__team__')) {
        setDrilldown({ id: id.slice('__team__'.length), name, metricId, metricName: m?.nameRu, kind: 'team' });
      } else if (id.startsWith('__branch__')) {
        setDrilldown({ id: id.slice('__branch__'.length), name, metricId, metricName: m?.nameRu, kind: 'branch' });
      } else {
        setDrilldown({ id, name, metricId, metricName: m?.nameRu });
      }
    },
    [catalogMetrics, availableMetrics]
  );

  // Копирование в буфер: чистый TSV для вставки в Google Таблицы — без пробелов-
  // разделителей тысяч, ₽ и %, десятичный разделитель — запятая.
  const dimensionColumnLabel = sourceMode
    ? (SOURCE_DIMENSION_LABELS[sourceDimension] ?? 'Источник')
    : reportSlug === 'by-product-groups' ? 'Товарная группа' : 'Менеджер';

  const handleCopyTable = useCallback(async () => {
    const cols = orderedMetrics as Metric[];
    const cell = (v: number | null | undefined, m: Metric) => {
      if (v === null || v === undefined) return '';
      const dec = metricDecimalOverrides[m.id] ?? m.decimalPlaces;
      return v.toFixed(dec).replace('.', ',');
    };
    const clean = (s: string) => s.replace(/[\t\n]/g, ' ');
    const lines: string[] = [];
    lines.push([dimensionColumnLabel, ...cols.map(m => clean(m.nameRu))].join('\t'));
    const pushRow = (r: MergedRow) => {
      lines.push([clean(r.dimensionName), ...cols.map(m => cell(r.deltas[m.id]?.current, m))].join('\t'));
    };
    for (const r of displayRows) {
      pushRow(r);
      const children = (r as GroupedMergedRow).children;
      if (children) for (const c of children) pushRow(c);
    }
    const totals: Deltas | null = data?.totals ?? null;
    if (totals && grouping !== 'total') {
      lines.push(['Итого', ...cols.map(m => cell(totals[m.id]?.current, m))].join('\t'));
    }
    await navigator.clipboard.writeText(lines.join('\n'));
  }, [orderedMetrics, displayRows, data?.totals, grouping, metricDecimalOverrides, dimensionColumnLabel]);

  const selectedMetricIds = metricIds.includes('all_core')
    ? availableMetrics.map((m: { id: string }) => m.id)
    : metricIds;

  const hasMixedDisplay = Object.keys(metricDisplayModes).length > 0;

  // Metric menu handlers
  function handleMetricDisplayModeChange(metricId: string, mode: ComparisonDisplay) {
    setMetricDisplayModes(prev => ({ ...prev, [metricId]: mode }));
  }

  // Быстрая кнопка «сравнение» в заголовке (п. Н5б спеки, ревизия): циклично переключает
  // режим ОДНОЙ метрики full → partial → compact → current → full. Данные
  // (comparison/delta/deltaPct) для всех метрик уже загружены вместе с current одним
  // фетчем — reports/run возвращает их всегда, независимо от режима отображения (см.
  // queryKey выше: metricDisplayModes/comparisonDisplay туда не входят). Поэтому
  // переключение — чистый re-render, БЕЗ обращения к сети и без refetch.
  const QUICK_CYCLE: ComparisonDisplay[] = ['full', 'partial', 'compact', 'current'];
  function handleMetricQuickCompareToggle(metricId: string) {
    const current = metricDisplayModes[metricId] ?? comparisonDisplay;
    const idx = QUICK_CYCLE.indexOf(current);
    const next = QUICK_CYCLE[(idx + 1) % QUICK_CYCLE.length];
    setMetricDisplayModes(prev => ({ ...prev, [metricId]: next }));
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
    setMetricFilters(prev => {
      if (!(metricId in prev)) return prev;
      const copy = { ...prev };
      delete copy[metricId];
      return copy;
    });
  }

  // «Фильтр и сортировка» (правка владельца 09.07) — применяются сразу, без «Сохранить»,
  // как и остальные тумблеры HighlightEditor (pin/accent/bar/heatmap).
  function handleColorZoneChange(metricId: string, zone: string | null) {
    setMetricFilters(prev => ({ ...prev, [metricId]: { ...prev[metricId], colorZone: zone } }));
  }
  function handleConditionChange(metricId: string, cond: MetricConditionFilter | null) {
    setMetricFilters(prev => ({ ...prev, [metricId]: { ...prev[metricId], condition: cond } }));
  }
  // Только одна метрика может «сортировать по цвету» одновременно (комбинировать с
  // сортировкой по цвету сразу нескольких метрик бессмысленно — порядок строк один);
  // включение для одной метрики гасит флаг у всех остальных.
  function handleSortByColorToggle(metricId: string) {
    setMetricFilters(prev => {
      const turningOn = !prev[metricId]?.sortByColor;
      const next: MetricFilters = {};
      for (const [id, f] of Object.entries(prev)) next[id] = { ...f, sortByColor: false };
      next[metricId] = { ...(next[metricId] ?? {}), sortByColor: turningOn };
      return next;
    });
  }
  function handleFilterReset(metricId: string) {
    setMetricFilters(prev => {
      if (!(metricId in prev)) return prev;
      const next = { ...prev };
      delete next[metricId];
      return next;
    });
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

  function handleMetricReorder(draggedId: string, targetId: string) {
    const ids = [...selectedMetricIds];
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1 || from === to) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
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
        // Кнопка настройки метрик доступна в обоих режимах (задача 1564: вернуть в
        // «Обычной» — раньше скрывалась вместе с остальными pro-only элементами по
        // п.3а спеки, но состав/подсветку метрик нужно менять и без Pro).
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
        zebra={zebra}
        onZebraChange={setZebra}
        borderMode={borderMode}
        onBorderModeChange={setBorderMode}
        showProductGroupPicker={true}
        productGroupMode={productGroupMode}
        onProductGroupModeChange={setProductGroupMode}
        onSaveReport={() => setShowSaveModal(true)}
        onCopyTable={handleCopyTable}
        basic={!isPro}
        onOpenComparison={() => setShowComparison(true)}
        comparisonCount={compareIds.length}
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
            dimensionLabel={dimensionColumnLabel}
            onRowClick={handleRowClick}
            onCellClick={handleCellClick}
            onSubtitleClick={dimensionType === 'manager' ? handleSubtitleClick : undefined}
            // «Обычная» скрывает настройки колонок и drag-перетаскивание (п.3а спеки) —
            // не передаём обработчики вовсе, ReportTable сам не рендерит соответствующий UI.
            // Перемещение (←/→) и удаление метрики (onMetricRemove/MoveLeft/MoveRight) больше
            // не идут через ReportTable — переехали в HighlightEditor вместе с упразднением
            // MetricMenu (правка 09.07), вызываются напрямую оттуда через configuringMetricId.
            onMetricQuickCompareToggle={isPro ? handleMetricQuickCompareToggle : undefined}
            onMetricReorder={isPro ? handleMetricReorder : undefined}
            onMetricConfigure={isPro ? (id) => setConfiguringMetricId(id) : undefined}
            metricDecimalOverrides={metricDecimalOverrides}
            metricThresholdOverrides={metricThresholdOverrides}
            accentedMetricIds={accentedMetricIds}
            barMetricIds={barMetricIds}
            heatmapMetricIds={heatmapMetricIds}
            heatmapInvertedIds={heatmapInvertedIds}
            colorizeMetrics={colorizeMetrics}
            zebra={zebra}
            borderMode={borderMode}
            numberAlign={numberAlign}
            pinnedMetricIds={pinnedMetricIds}
            onMetricPinToggle={(id) => setPinnedMetricIds(prev =>
              prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
            )}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={(by, dir) => { setSortBy(by); setSortDir(dir); }}
            metricFilters={metricFilters}
            columnGroups={columnGroups}
            density={viewPrefs.density}
            tableScale={tableScaleMult}
          />
        )}
      </div>

      {drilldown && (
        <DrilldownDrawer
          key={`${drilldown.id}:${drilldown.metricId ?? ''}`}
          target={drilldown}
          dimensionType={dimensionType}
          period={period}
          comparison={comparison}
          dealScope={dealScope}
          clientType={clientType}
          productGroupMode={productGroupMode}
          metricIds={drilldownDuplicate || drilldownMetricIds.length === 0 ? metricIds : drilldownMetricIds}
          departmentIds={departmentIds}
          accountType={accountType}
          dealFields={dealFields}
          sortBy={sortBy}
          sortDir={sortDir}
          grouped={drilldownGrouped}
          onGroupedChange={setDrilldownGrouped}
          comparisonDisplay={comparisonDisplay}
          metricDisplayModes={metricDisplayModes}
          comparisonThreshold={comparisonThreshold}
          highlights={effectiveHighlights}
          metricDecimalOverrides={metricDecimalOverrides}
          metricThresholdOverrides={metricThresholdOverrides}
          accentedMetricIds={accentedMetricIds}
          barMetricIds={barMetricIds}
          heatmapMetricIds={heatmapMetricIds}
          heatmapInvertedIds={heatmapInvertedIds}
          colorizeMetrics={colorizeMetrics}
          zebra={zebra}
          borderMode={borderMode}
          numberAlign={numberAlign}
          pinnedMetricIds={pinnedMetricIds}
          columnGroups={columnGroups}
          density={viewPrefs.density}
          tableScale={tableScaleMult}
          sourceDimension={sourceMode ? sourceDimension : undefined}
          drilldownDimension={sourceMode ? drilldownDimension : undefined}
          onDrilldownDimensionChange={sourceMode ? setDrilldownDimension : undefined}
          toolbarExtras={
            // Тип сделок/клиента/аккаунтов, товарные группы, период и отделы теперь —
            // собственные (независимые от основного отчёта) фильтры дрилл-дауна,
            // см. DrilldownDrawer. Здесь остаются только настройки ОТОБРАЖЕНИЯ,
            // общие с основным отчётом (плотность, шрифт, режим колонок, цвет, зебра).
            <ViewSettings
              prefs={viewPrefs}
              onChange={updateViewPrefs}
              numberAlign={numberAlign}
              onNumberAlignChange={setNumberAlign}
              drilldownGrouped={drilldownGrouped}
              onDrilldownGroupedChange={setDrilldownGrouped}
              colorizeMetrics={colorizeMetrics}
              onColorizeMetricsChange={setColorizeMetrics}
              zebra={zebra}
              onZebraChange={setZebra}
              borderMode={borderMode}
              onBorderModeChange={setBorderMode}
            />
          }
          onClose={() => setDrilldown(null)}
        />
      )}

      {managerCard && (
        <ManagerCardPanel
          key={managerCard.id}
          managerId={managerCard.id}
          managerName={managerCard.name}
          reportPeriod={period}
          onClose={() => setManagerCard(null)}
        />
      )}

      {showComparison && (
        <ComparisonPanel
          rows={data?.rows ?? []}
          metrics={orderedMetrics as Metric[]}
          entityLabel={dimensionColumnLabel}
          selectedIds={compareIds}
          onSelectedIdsChange={setCompareIds}
          metricDecimalOverrides={metricDecimalOverrides}
          onClose={() => setShowComparison(false)}
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
        // Положение метрики среди колонок отчёта — по тому же массиву (selectedMetricIds),
        // которым оперируют handleMetricMoveLeft/Right (правка 09.07, упразднение MetricMenu):
        // ←/→/«Убрать» переехали из контекстного меню шестерёнки прямо в эту панель.
        const configuringIdx = selectedMetricIds.indexOf(configuringMetricId);
        const configuringIsFirst = configuringIdx <= 0;
        const configuringIsLast = configuringIdx === -1 || configuringIdx === selectedMetricIds.length - 1;
        return (
          <HighlightEditor
            key={configuringMetricId}
            // Док-режим (рядом с панелью метрик) — только на десктопе: на телефоне
            // панель метрик во весь экран, редактор выезжает поверх справа
            anchorLeft={showMetricPanel && !isMobile ? 220 + getMetricPanelWidth() : undefined}
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
            isHeatmap={isHeatmapEnabled(configuringMetricId, isRelativeDataType(m?.dataType), heatmapMetricIds)}
            onHeatmapToggle={() => setHeatmapMetricIds(prev =>
              toggleHeatmap(configuringMetricId!, isRelativeDataType(m?.dataType), prev)
            )}
            isHeatmapInverted={heatmapInvertedIds.includes(configuringMetricId)}
            onHeatmapInvertToggle={() => setHeatmapInvertedIds(prev =>
              prev.includes(configuringMetricId!) ? prev.filter(x => x !== configuringMetricId) : [...prev, configuringMetricId!]
            )}
            onThresholdsClear={handleThresholdsClear}
            decimalPlaces={metricDecimalOverrides[configuringMetricId] ?? m?.decimalPlaces ?? 2}
            onDecimalPlacesChange={(v) => setMetricDecimalOverrides(prev => ({ ...prev, [configuringMetricId!]: v }))}
            comparisonThreshold={metricThresholdOverrides[configuringMetricId] ?? (m?.dataType === 'percent' ? 10 : 5)}
            onComparisonThresholdChange={(v) => setMetricThresholdOverrides(prev => ({ ...prev, [configuringMetricId!]: v }))}
            isFirst={configuringIsFirst}
            isLast={configuringIsLast}
            onMoveLeft={() => handleMetricMoveLeft(configuringMetricId!)}
            onMoveRight={() => handleMetricMoveRight(configuringMetricId!)}
            onRemove={() => { handleMetricRemove(configuringMetricId!); setConfiguringMetricId(null); }}
            filterState={metricFilters[configuringMetricId]}
            onColorZoneChange={(zone) => handleColorZoneChange(configuringMetricId!, zone)}
            onConditionChange={(cond) => handleConditionChange(configuringMetricId!, cond)}
            onSortByColorToggle={() => handleSortByColorToggle(configuringMetricId!)}
            onFilterReset={() => handleFilterReset(configuringMetricId!)}
          />
        );
      })()}

      {showSaveModal && (
        <SaveReportModal
          reportSlug={reportSlug}
          initialName={title}
          currentReportId={preset?.id ?? null}
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
          zebra={zebra}
          borderMode={borderMode}
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
