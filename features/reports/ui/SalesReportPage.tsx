'use client';
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { DealFilterButton } from './DealFilterButton';
import { describeDealFilters, type DealFilter } from '@/lib/metrics/dealFilters';
import { useUrlState, dateRangeParam, enumParam, stringParam, type UrlDateRange } from '@/lib/hooks/useUrlState';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2, Info, Filter } from 'lucide-react';
import { hasPerm } from '@/lib/auth/perms';
import type { SessionUser } from '@/lib/auth/session';
import { defaultPeriod, defaultComparison } from '@/lib/period';
import { useAccountDepartments } from '@/lib/hooks/useAccountDepartments';
import { FilterBar, countAllDepartmentIds } from './FilterBar';
import { ReportToolbar } from './ReportToolbar';
import { MobileReportBar } from './MobileReportBar';
import { ReportTable } from './ReportTable';
import { MetricPanel, getMetricPanelWidth } from './MetricPanel';
import { ViewSettings, loadViewPrefs, saveViewPrefs, DEFAULT_VIEW_PREFS, type ViewPrefs } from './ViewSettings';
import { HighlightEditor } from './HighlightEditor';
import { SaveReportModal } from './SaveReportModal';
import { DrilldownDrawer } from './DrilldownDrawer';
import { MetricChartModal, type MetricChartTarget } from './MetricChartModal';
import type { DrilldownTarget } from './DrilldownDrawer';
import { ComparisonPanel } from './ComparisonPanel';
import { computeCalculated } from '@/features/reports/engine/calculated';
import type { DealScope, ClientType, Grouping, Metric, ProductGroupMode, ComparisonDisplay, BorderMode, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';
import type { DateRange, CalendarUnit } from '@/lib/period';
import type { PeriodsDimension, CompareMode } from '@/features/reports/engine/byPeriods';
import { PeriodReportControls } from './PeriodReportControls';
import { bucketRange, comparisonBucketOf } from '@/features/reports/lib/periodBuckets';
import type { MetricHighlightConfig, SavedReport, SavedReportInput } from '@/lib/saved-reports/types';
import { resolveRelativePeriod, resolveComparison } from '@/lib/saved-reports/period';
import type { MetricFilters, MetricConditionFilter } from '@/lib/reports/metricFilter';
import { type SourceDimension, type DrilldownDimension } from '@/lib/marketing/dimensions';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { branchLabel } from '@/lib/org/branchLabel';
import { isHeatmapEnabled, isRelativeDataType, toggleHeatmap } from '@/lib/metrics/heatmapDefault';
import { useTableScale } from '@/lib/hooks/useTableScale';
import { buildExportTable, tableToTsv, type ExportSourceRow, type ExportTotals } from '@/features/reports/lib/tableExport';
import { buildExportFilename } from '@/features/reports/lib/exportFilename';
import { exportTableToExcel } from '@/features/reports/lib/exportExcel';
import { exportNodeToPng } from '@/features/reports/lib/exportImage';
import { exportNodeToPdf } from '@/features/reports/lib/exportPdf';
import { UserGroupsBar, CreateGroupButton, GroupSelectPanel, type UserReportGroup } from './UserGroupsBar';
import { ReportTabsBar } from './ReportTabsBar';
import { loadTabsStore, saveTabsStore, newTabId, type ReportTab, type ReportTabSnapshot, type ReportTabsStore } from '@/features/reports/lib/reportTabs';
import { diffFromPreset } from '@/features/reports/lib/presetDiff';

type Deltas = Record<string, { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null }>;

type MergedRow = {
  dimensionId: string;
  dimensionName: string;
  dimensionSubtitle?: string;
  teamId: string | null;
  teamName: string | null;
  branchName?: string | null;
  deltas: Deltas;
  // Пользовательская группа (задача 2653): у синтетической строки — число
  // участников (для честного «N чел.» в подытогах при группировке).
  ugroupSize?: number;
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

// Синтетическая строка «Без группы» (правка Серёги 31.07 №1): id-константа —
// дискриминатор в обработчиках кликов и в ReportTable (свёрнута по умолчанию).
export const NOGROUP_ROW_ID = '__ugroup__nogroup__';

// Пользовательские группы (задача 2653): участники схлопываются в строку-агрегат
// с ТОЙ ЖЕ агрегацией, что у строк отдела/филиала (aggregateGroupDeltas —
// суммы + пересчёт calculated по формуле, сравнение периодов включено).
// Строка группы — isGroup с children: участники «исчезают из общего списка» и
// живут внутри группы (раскрываются шевроном).
// withNoGroup (правка Серёги 31.07 №1): все НЕ вошедшие ни в одну группу строки
// схлопываются в одну агрегатную «Без группы» (тот же движок aggregateGroupDeltas,
// children = участники). Решение по сочетанию с группировкой: «Без группы»
// работает ТОЛЬКО в режиме «Без группировки» (grouping='none') — при группировке
// по отделу/филиалу/итого поведение прежнее (свободные строки остаются в своих
// отделах; «Без группы» поверх отделов дублировала бы их подытоги, а внутри
// каждого отдела теряла бы смысл «всё остальное»). Сброс всех групп возвращает
// обычный вид (groups.length===0 → rows как есть).
function applyUserGroups(rows: MergedRow[], groups: UserReportGroup[], metrics: Metric[], withNoGroup = false): GroupedMergedRow[] {
  if (groups.length === 0) return rows;
  const memberOf = new Map<string, string>();
  for (const g of groups) for (const m of g.member_ids) memberOf.set(m, g.id);
  const byGroup = new Map<string, MergedRow[]>();
  const rest: MergedRow[] = [];
  for (const r of rows) {
    const gid = memberOf.get(r.dimensionId);
    if (gid) {
      const arr = byGroup.get(gid) ?? [];
      arr.push(r);
      byGroup.set(gid, arr);
    } else rest.push(r);
  }
  const groupRows: GroupedMergedRow[] = [];
  for (const g of groups) {
    const members = byGroup.get(g.id) ?? [];
    if (members.length === 0) continue; // участники не в текущем срезе — группу не рисуем
    // Общий отдел/филиал участников (этап 2 — работа при группировке): если все
    // из одного отдела, строка группы живёт ВНУТРИ него; иначе поднимается на
    // верхний уровень (см. displayRows). Аналогично для филиала.
    const commonTeam = members.every(m => m.teamId === members[0].teamId) ? members[0].teamId : null;
    const commonBranch = members.every(m => (m.branchName ?? 'СПб') === (members[0].branchName ?? 'СПб')) ? (members[0].branchName ?? 'СПб') : null;
    groupRows.push({
      dimensionId: `__ugroup__${g.id}`,
      dimensionName: `${g.name} (${members.length})`,
      teamId: commonTeam, teamName: commonTeam ? members[0].teamName : null,
      branchName: commonBranch,
      ugroupSize: members.length,
      deltas: aggregateGroupDeltas(members, metrics),
      isGroup: true, children: members,
    });
  }
  // Авто-«Без группы»: рисуем, только если хоть одна группа реально видна в срезе
  // (иначе схлопнули бы ВЕСЬ отчёт в одну строку без пользы) и есть кого собирать.
  // Инвариант сверки: Σ(группы) + «Без группы» = Итого отчёта — участники не
  // теряются и не двоятся (каждая строка попадает ровно в один из двух наборов).
  if (withNoGroup && groupRows.length > 0 && rest.length > 0) {
    return [...groupRows, {
      dimensionId: NOGROUP_ROW_ID,
      dimensionName: `Без группы (${rest.length})`,
      teamId: null, teamName: null, branchName: null,
      ugroupSize: rest.length,
      deltas: aggregateGroupDeltas(rest, metrics),
      isGroup: true, children: rest,
    }];
  }
  return [...groupRows, ...rest];
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
        // Пользовательская группа целиком из этого филиала (задача 2653, этап 2):
        // отдаём её собственную строку (isGroup с участниками), а не безликий
        // подытог — дрилл-даун/раскрытие группы сохраняются и внутри филиала.
        if (tm.length === 1 && tm[0].dimensionId.startsWith('__ugroup__')) {
          return { ...tm[0], dimensionSubtitle: `${tm[0].ugroupSize ?? 1} уч.` };
        }
        const teamName = tm[0]?.teamName ?? 'Без отдела';
        const headcount = tm.reduce((sum, r) => sum + (r.ugroupSize ?? 1), 0);
        return {
          dimensionId: `__team__${tk}`,
          dimensionName: teamName,
          dimensionSubtitle: `${headcount} чел.`,
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
  // «Создать отчёт» (задача 1572): страница открыта как /sales/{slug}?new=1 —
  // пустой отчёт выбранной сущности в режиме редактирования. Влияет на:
  // (1) стартовый набор метрик — пустой, а не DEFAULT_METRIC_IDS;
  // (2) подсказку «Добавьте метрики», пока метрик нет.
  // (было: (3) точечное разрешение «Сохранить» в Лайте только для этого флоу —
  // с задачи 2990 «Сохранить» показывается всегда вне зависимости от basic, см.
  // ReportToolbar.tsx; forceShowSave/isNew ниже оставлен как безвредный no-op.)
  isNew?: boolean;
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

export function SalesReportPage({ reportSlug, title, preset, isNew = false }: Props) {
  const isMobile = useIsMobile();
  const router = useRouter();
  const qc = useQueryClient();

  // Задача 2824: приоритет источников состояния — URL (если параметр явно
  // присутствует в адресе) ПОБЕЖДАЕТ и пресет сохранённого отчёта, и restore
  // вкладки из localStorage. Иначе открытие диплинка вида
  // `/sales/saved/<id>?dealScope=primary` тут же затиралось бы обратно
  // значением из сохранённого отчёта на первом же useEffect ниже — весь смысл
  // «пришли ссылку с настройками» терялся бы молча. urlHasRef — снимок ДО
  // применения preset/tab-restore эффектов на монтировании; сами эти эффекты
  // держат стабильный deps-массив (см. их eslint-disable рядом), поэтому
  // читаем актуальные searchParams через ref, а не добавляем их в зависимости.
  const searchParams = useSearchParams();
  const urlHasRef = useRef(searchParams);
  urlHasRef.current = searchParams;
  const urlHas = useCallback((key: string) => urlHasRef.current.has(key), []);

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

  // Переименование/удаление отчёта из заголовка (задача 1605, финальное решение
  // владельца 10.07/3): раньше карандаш+корзинка стояли в строке сайдбара — три
  // раунда правок владелец забраковал каждый вариант компоновки там и решил
  // убрать их из сайдбара насовсем, перенеся в заголовок ОТКРЫТОГО отчёта
  // (по hover на title, «туда просто так мышкой никто не лазит»). Права те же,
  // что были в AppShell.tsx: свой личный отчёт правит владелец, витринный —
  // admin (action.shared_reports.manage) — то же правило, что canDeleteShared/
  // ownReports там же. currentUser грузится тем же эндпоинтом, что и в
  // SaveReportModal.tsx (единственный источник сессии на клиенте).
  const { data: currentUser } = useQuery<SessionUser | null>({
    queryKey: ['auth-session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session');
      if (!res.ok) return null;
      const data = await res.json();
      return data.user ?? null;
    },
    staleTime: 60_000,
  });
  const canManageReport = !!preset && !!currentUser && (
    preset.isShared ? hasPerm(currentUser, 'action.shared_reports.manage') : preset.userLogin === currentUser.login
  );
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(title);
  useEffect(() => { setTitleValue(title); }, [title]);

  async function commitTitleRename() {
    setRenamingTitle(false);
    const trimmed = titleValue.trim();
    if (!preset || !trimmed || trimmed === preset.name) { setTitleValue(title); return; }
    const res = await fetch(`/api/saved-reports/${preset.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.ok) {
      qc.invalidateQueries({ queryKey: ['saved-reports'] });
      router.refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error ?? 'Не удалось переименовать отчёт');
      setTitleValue(title);
    }
  }

  async function handleDeleteReport() {
    if (!preset) return;
    // Требование владельца (та же формулировка, что раньше была в сайдбаре):
    // подтверждение обязательно — кнопки рядом, промахнуться легко. Удаление
    // мягкое (уходит в корзину, откуда можно восстановить) — уточняем в тексте.
    if (!confirm(`Удалить отчёт «${preset.name}»? Он переместится в корзину — оттуда можно восстановить.`)) return;
    await fetch(`/api/saved-reports/${preset.id}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['saved-reports'] });
    qc.invalidateQueries({ queryKey: ['saved-reports-trash'] });
    router.push('/home');
  }
  // ── Задача 2824 (план из аудита адресуемости, п.1.1) ────────────────────────
  // Поля отчёта, которые реально определяют «какой это отчёт» — период,
  // сравнение, срез сделок/клиентов, группировка, набор метрик, поиск,
  // сортировка, доп.фильтры — переведены на useUrlState: это то, что
  // ФАКТИЧЕСКИ уходит в /api/reports/run (см. queryKey/queryFn ниже) и то,
  // ради чего пересылают ссылку на отчёт. Формат-настройки отображения (зебра,
  // границы, цвет метрик, точность, дрилл-даун-детали и т.п.) остаются
  // локальным useState — это персональные предпочтения ПРОСМОТРА, а не
  // «какой отчёт открыт» (та же граница, что и так уже проведена для viewPrefs
  // в localStorage, см. ниже). Контракт хука и разбор границы — WORKLOG,
  // задача 2824, и `ai_docs/fresh_docs/DESIGN_GUIDELINES.md`.
  //
  // default вычисляется ОДИН раз на монтирование (не на каждый рендер) — иначе
  // «текущий момент» внутри defaultPeriod()/defaultComparison() гулял бы между
  // рендерами и путал сравнение «равно дефолту → не пишем в URL» (см. коммент
  // в lib/hooks/useUrlState.ts::dateRangeParam).
  const initialPeriod = useMemo<UrlDateRange>(defaultPeriod, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Дефолт НОВОГО отчёта (без сохранённого пресета) — предыдущий период ТОЙ ЖЕ
  // длины, вплотную к началу основного (задача 1666: регрессия f9d69d4 подставляла
  // сюда календарный «весь предыдущий месяц» — это семантика ЯВНОГО клика по
  // быстрой кнопке-пресету, см. calendarComparisonForPreset в lib/period, а не
  // дефолта конструктора). См. lib/period::defaultComparison.
  const initialComparison = useMemo<UrlDateRange>(defaultComparison, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [period, setPeriod]             = useUrlState<DateRange>('period', dateRangeParam(initialPeriod));
  const [comparison, setComparison]     = useUrlState<DateRange>('cmp', dateRangeParam(initialComparison));
  const [dealScope, setDealScope]       = useUrlState<DealScope>('dealScope', enumParam(['primary', 'repeat', 'all'], 'all'));
  const [clientType, setClientType]     = useUrlState<ClientType>('clientType', enumParam(['all', 'b2c', 'b2b'], 'all'));
  const [grouping, setGrouping]         = useUrlState<Grouping>('grouping', enumParam(['none', 'team', 'branch', 'total'], 'none'));
  // Отчёт «По периодам» (задача владельца 09.08): шаг группировки, разрез дрилла и
  // база сравнения. Все три определяют «какой это отчёт» — значит в URL, как период
  // и срез (та же граница, что описана выше). В остальных отчётах не используются.
  const [periodUnit, setPeriodUnit]           = useUrlState<CalendarUnit>('unit', enumParam(['day', 'week', 'month', 'quarter', 'year'], 'month'));
  const [periodDimension, setPeriodDimension] = useUrlState<PeriodsDimension>('dim', enumParam(['managers', 'product-groups'], 'managers'));
  const [compareMode, setCompareMode]         = useUrlState<CompareMode>('cmpMode', enumParam(['prev', 'yoy', 'none'], 'prev'));
  // «Создать отчёт» (задача 1572): новый отчёт стартует БЕЗ метрик (пустая
  // колонка сущности + подсказка ниже) — preset (если он всё же передан,
  // например прямой заход на /sales/saved/[id]) всегда выигрывает у isNew
  // через useEffect ниже, так что порядок приоритета верный.
  //
  // ВАЖНО (задача 2881, откат находки инцидента #2870): metricIds сознательно
  // НЕ на useUrlState, в отличие от соседних полей ниже. Волна 1 (#2824) сперва
  // перевела набор метрик на URL как источник правды — со стороны выглядело
  // симметрично остальным полям, но здесь другая семантика: удаление
  // метрики-колонки крестиком (штатное, всегда было чисто визуальным и
  // сбрасывалось на F5) начало писаться в URL через router.replace. При
  // следующем восстановлении вкладки/F5 `urlHas('metrics')` был true, и полный
  // пресет сохранённого отчёта из БД переставал применяться — второй источник
  // того же класса проблемы, что и снапшот вкладки в localStorage (см.
  // reportTabs.ts), только теперь ещё и в URL. Разбор — WORKLOG 03.08 (#2870),
  // `owners-inbox/analsteroid-incident-2870-wave1-rollback.html`. Период/срез/
  // группировка/сортировка на URL остаются — там «URL побеждает при первом
  // монтировании» корректная семантика (диплинк), у набора метрик — нет.
  const [metricIds, setMetricIds]       = useState<string[]>(isNew ? [] : DEFAULT_METRIC_IDS);
  const [fetchedMetricIds, setFetchedMetricIds] = useState<string[]>(isNew ? [] : DEFAULT_METRIC_IDS);
  // Выбор отделов — настройка АККАУНТА, не отчёта (задача Иосифа 15.07, миграция 102):
  // одно значение на пользователя для всех отчётов; из конфигов сохранённых отчётов
  // departmentIds больше не применяется (см. пропуск в useEffect preset ниже).
  const { departmentIds, ready: departmentsReady, setDepartmentIds } = useAccountDepartments();
  const [comparisonDisplay, setComparisonDisplay] = useUrlState<ComparisonDisplay>('cmpDisplay', enumParam(['full', 'partial', 'compact', 'current'], 'current'));
  const [metricDisplayModes, setMetricDisplayModes] = useState<Record<string, ComparisonDisplay>>({});
  const [comparisonThreshold, setComparisonThreshold] = useState<number>(5);
  // Дефолт группировки по товарам для НОВОГО отчёта — «Категория КЦ» (kc), правка
  // владельца (Серёга, 13.07): во всех отчётах товары по умолчанию считаются по
  // системе «Категория КЦ», а не «По наибольшему» (by_max).
  const [productGroupMode, setProductGroupMode]   = useUrlState<ProductGroupMode>('productGroupMode', enumParam(['kc', 'by_max'], 'kc'));
  const [highlights, setHighlights]     = useState<Record<string, MetricHighlightConfig>>({});
  const [search, setSearch]             = useUrlState<string>('q', stringParam(''));
  const [drilldown, setDrilldown]       = useState<DrilldownTarget | null>(null);
  // «График из отчёта» (фича Серёги 01.08): цель открытого графика метрики.
  const [chartTarget, setChartTarget]   = useState<MetricChartTarget | null>(null);
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
  const [accountType, setAccountType] = useUrlState<'managers' | 'logists' | 'all'>('accountType', enumParam(['managers', 'logists', 'all'], 'managers'));
  const [drilldownDuplicate, setDrilldownDuplicate] = useState(true);
  const [drilldownMetricIds, setDrilldownMetricIds] = useState<string[]>([]);
  const [dealFields, setDealFields] = useState<string[] | undefined>(undefined);
  const [drilldownGrouped, setDrilldownGrouped] = useState(true);
  const [sourceDimension, setSourceDimension] = useUrlState<SourceDimension>('sourceDim', enumParam(
    ['brand', 'platform', 'contact_type', 'ad_channel', 'channel_group', 'branch', 'source'], 'brand',
  ));
  const [drilldownDimension, setDrilldownDimension] = useState<DrilldownDimension>('contact_type');
  const [sortBy, setSortBy] = useUrlState<string | null>('sortBy', {
    parse: (raw) => raw,
    serialize: (v) => v,
    default: null,
  });
  const [sortDir, setSortDir] = useUrlState<'asc' | 'desc'>('sortDir', enumParam(['asc', 'desc'], 'desc'));
  // Фильтр по цвету/условию + сортировка по цвету (правка владельца 09.07, панель
  // настроек метрики → «Фильтр и сортировка»). Намеренно СЕССИОННОЕ состояние — не
  // персистится в SavedReport (меньше риска на первый заход), сбрасывается сменой отчёта.
  const [metricFilters, setMetricFilters] = useState<MetricFilters>({});
  // Задача 1569 (владелец, «побаловаться») — экспериментальные фильтры сегментации
  // по нерабочему времени («Создана» / «Первая обработка», см. FiltersMenu.tsx +
  // lib/metrics/offHoursFilters.ts). Тем же паттерном, что metricFilters выше:
  // намеренно СЕССИОННОЕ состояние, НЕ персистится в SavedReport — добавление
  // персистентности потребовало бы миграции БД (saved_reports — типизированная
  // таблица без catch-all JSON-колонки, см. отчёт задачи), что вне разрешённых
  // правок этой задачи; сбрасывается сменой отчёта, как metricFilters.
  // Задача 2824: в URL всё же вынесены (это тоже «фильтры», см. план п.1.1) —
  // сессионность касалась только SavedReport-персистентности, не адресуемости.
  const [createdTimeFilter, setCreatedTimeFilter] = useUrlState<CreatedTimeFilter>('createdTime', enumParam(
    ['all', 'business_hours', 'weekday_after_hours', 'weekend'], 'all',
  ));
  const [firstTouchFilter, setFirstTouchFilter] = useUrlState<FirstTouchFilter>('firstTouch', enumParam(
    ['all', 'off_hours', 'business_hours'], 'all',
  ));
  // «Фильтр сделок» (задача владельца 07.08): условия, режущие набор сделок ВСЕГО
  // отчёта. В отличие от createdTimeFilter выше, персистится и в URL, и в
  // сохранённом отчёте (решение владельца: «сохранять и в ссылке, и в отчёте» —
  // чтобы можно было сделать постоянный «Отчёт по крупным сделкам» и скинуть его
  // РОПу ссылкой). JSON в query-параметре: условий немного, а собственный
  // компактный формат пришлось бы парсить в двух местах.
  const [dealFilters, setDealFilters] = useUrlState<DealFilter[]>('dealFilters', {
    parse: (raw) => {
      if (!raw) return [];
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v as DealFilter[] : [];
      } catch { return []; }
    },
    serialize: (v) => (v.length ? JSON.stringify(v) : null),
    default: [],
  });
  const [columnGroups, setColumnGroups] = useState<{ name: string; metricIds: string[] }[]>([]);
  const [viewPrefs, setViewPrefs] = useState<ViewPrefs>(DEFAULT_VIEW_PREFS);

  useEffect(() => { setViewPrefs(loadViewPrefs()); }, []);
  function updateViewPrefs(p: ViewPrefs) { setViewPrefs(p); saveViewPrefs(p); }

  // «Масштаб таблиц» ЛК (бриф 09.07, п.3): глобальный per-user множитель, применяется
  // ко всем таблицам отчёта (основная/дрилл-даун/сделки) — НЕ per-report настройка,
  // источник — users.table_scale (см. ViewSettings.tsx — «Размер шрифта» убран оттуда).
  const { tableScaleMult } = useTableScale();

  // Задача 2824 + 2881: применение пресета сохранённого отчёта к состоянию экрана,
  // вынесено в отдельный callback (раньше было телом эффекта ниже) — тот же код
  // теперь нужен из ДВУХ мест: (1) на монтировании/смене пресета — с приоритетом
  // явного query-параметра диплинка (opts.respectUrl), (2) из кнопки «Вернуть
  // исходный вид» плашки расхождения — целиком, БЕЗ оглядки на URL (осознанное
  // действие пользователя, тот же принцип, что уже применяется в applyTabSnapshot
  // ниже при явном выборе вкладки). metricIds — БЕЗ keep()-гейта вовсе: как
  // объяснено у объявления состояния выше, набор метрик больше не живёт в URL.
  const applyPreset = useCallback((p: SavedReport, opts?: { respectUrl?: boolean }) => {
    const keep = (key: string) => !!opts?.respectUrl && urlHasRef.current.has(key);
    if (p.periodMode === 'relative' && p.relativePeriod) {
      const per = resolveRelativePeriod(p.relativePeriod);
      const c = resolveComparison(per, p.comparisonMode, p.relativePeriod);
      if (!keep('period')) setPeriod(per);
      if (!keep('cmp')) setComparison(c);
    } else if (p.fixedPeriod) {
      if (!keep('period')) setPeriod({ from: new Date(p.fixedPeriod.from), to: new Date(p.fixedPeriod.to) });
      if (p.fixedComparison && !keep('cmp')) {
        setComparison({ from: new Date(p.fixedComparison.from), to: new Date(p.fixedComparison.to) });
      }
    }
    if (!keep('dealScope')) setDealScope(p.dealScope);
    if (!keep('clientType')) setClientType(p.clientType);
    if (!keep('grouping')) setGrouping(p.grouping);
    if (!keep('cmpDisplay')) setComparisonDisplay(p.comparisonDisplay);
    setMetricDisplayModes(p.metricDisplayModes ?? {});
    setComparisonThreshold(p.comparisonThreshold ?? 5);
    if (!keep('productGroupMode')) setProductGroupMode(p.productGroupMode);
    // p.departmentIds сознательно НЕ применяется: выбор отделов — настройка
    // аккаунта (useAccountDepartments), сохранённый отчёт её не перетирает.
    const ids = p.metricIds.length ? p.metricIds : ['all_core'];
    setMetricIds(ids);
    setFetchedMetricIds(ids);
    setHighlights(p.metricHighlights ?? {});
    setPinnedMetricIds(p.pinnedMetricIds ?? []);
    setMetricDecimalOverrides(p.metricDecimalOverrides ?? {});
    setMetricThresholdOverrides(p.metricThresholdOverrides ?? {});
    setAccentedMetricIds(p.accentedMetricIds ?? []);
    setBarMetricIds(p.barMetricIds ?? []);
    setHeatmapMetricIds(p.heatmapMetricIds ?? []);
    setHeatmapInvertedIds(p.heatmapInvertedIds ?? []);
    setColorizeMetrics(p.colorizeMetrics ?? false);
    setZebra(p.zebra ?? false);
    setBorderMode(p.borderMode ?? 'grid');
    setThemeAccent(p.themeAccent ?? null);
    setNumberAlign(p.numberAlign ?? 'center');
    if (!keep('accountType')) setAccountType(p.accountType ?? 'managers');
    setDrilldownDuplicate(p.drilldownDuplicateMetrics ?? true);
    setDrilldownMetricIds(p.drilldownMetricIds ?? []);
    setDealFields(p.dealFields ?? undefined);
    setDrilldownGrouped(p.drilldownGrouped ?? true);
    if (!keep('sourceDim')) setSourceDimension((p.sourceDimension as SourceDimension) ?? 'brand');
    setDrilldownDimension((p.drilldownDimension as DrilldownDimension) ?? 'contact_type');
    if (!keep('sortBy')) setSortBy(p.sortBy ?? null);
    if (!keep('sortDir')) setSortDir(p.sortDir ?? 'desc');
    setColumnGroups(p.columnGroups ?? []);
    // «По периодам» (миграция 170): у отчётов остальных типов колонки пустые —
    // дефолты те же, что у нового отчёта.
    if (!keep('unit')) setPeriodUnit((p.periodUnit as CalendarUnit) ?? 'month');
    if (!keep('dim')) setPeriodDimension(p.periodDimension ?? 'managers');
    if (!keep('cmpMode')) setCompareMode(p.compareMode ?? 'prev');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!preset) return;
    applyPreset(preset, { respectUrl: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.id]);

  // Плашка расхождения (задача 2881): показывается ТОЛЬКО для реального
  // сохранённого отчёта из БД — встроенные пресеты (/sales/by-managers и т.п.)
  // вообще не передают preset (сравнивать не с чем); синтетический пресет
  // /marketing/[preset] (см. app/(app)/marketing/[preset]/page.tsx) собирается
  // в коде на лету и не лежит в saved_reports — userLogin у него пустая строка
  // (маркер «не настоящий сохранённый отчёт», реальные строки БД всегда с
  // логином владельца), у такого пресета «вернуть исходный» не имеет смысла
  // «вернуть к сохранённому», это и так текущий дефолт страницы.
  const isSavedPreset = !!preset?.userLogin;
  const presetDiff = useMemo(() => {
    if (!isSavedPreset || !preset) return [];
    return diffFromPreset(preset, {
      metricIds, dealScope, clientType, grouping, comparisonDisplay,
      productGroupMode, accountType, sourceDimension, sortBy, sortDir,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSavedPreset, preset, metricIds, dealScope, clientType, grouping, comparisonDisplay, productGroupMode, accountType, sourceDimension, sortBy, sortDir]);

  function handleResetToPreset() {
    if (!preset) return;
    // Без opts — целиком, без оглядки на URL (осознанное действие пользователя).
    // Обновляет React-состояние; персист-эффект вкладки (ниже) сам подхватит
    // новый снапшот и перезапишет localStorage на следующем рендере — F5 после
    // этого клика покажет ИМЕННО исходный вид, а не откат к прежнему состоянию
    // вкладки (проверено ручным сценарием, см. WORKLOG).
    applyPreset(preset);
  }

  // ── Вкладки отчётов «как в браузере» (фича Серёги 01.08) ────────────────────
  // Вкладка = экземпляр отчёта со своим полным состоянием (reportTabs.ts),
  // хранение localStorage per-user — осознанно эфемерно (НЕ БД/избранное).
  // Рендерится только активная вкладка (страница монтирует один SalesReportPage),
  // неактивные — сериализованный JSON, живых запросов не держат. Правила:
  //  * прямой заход по URL (сайдбар/диплинк) активирует последнюю вкладку этого
  //    route или создаёт новую — «открытие по URL = активная вкладка»; ?new=1
  //    всегда создаёт свежую;
  //  * «+» — новая вкладка-КОПИЯ текущего отчёта (UX-решение: сохраняет контекст,
  //    дефолтный отчёт всегда доступен сайдбаром);
  //  * переключение снапшотит текущую вкладку синхронно ДО ухода;
  //  * restore стоит ПОСЛЕ preset-эффекта — состояние вкладки выигрывает
  //    (это и есть «настроил и вернулся»);
  //  * навигация между route-ами НЕ ремоунтит SalesReportPage (React сохраняет
  //    инстанс одинакового типа) — поэтому сброс tabsRestoredRef по pathname.
  const pathname = usePathname();
  const [tabsStore, setTabsStore] = useState<ReportTabsStore | null>(null);
  const tabsLogin = currentUser === undefined ? undefined : (currentUser?.login ?? null);
  const tabsRestoredRef = useRef(false);

  const buildTabSnapshot = useCallback((): ReportTabSnapshot => ({
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    comparison: { from: comparison.from.toISOString(), to: comparison.to.toISOString() },
    dealScope, clientType, grouping, metricIds,
    comparisonDisplay,
    metricDisplayModes: metricDisplayModes as Record<string, string>,
    comparisonThreshold, productGroupMode,
    highlights: highlights as Record<string, unknown>,
    pinnedMetricIds, metricDecimalOverrides, metricThresholdOverrides,
    accentedMetricIds, barMetricIds, heatmapMetricIds, heatmapInvertedIds,
    colorizeMetrics, zebra, borderMode, numberAlign, accountType,
    drilldownDuplicate, drilldownMetricIds, dealFields, drilldownGrouped,
    sourceDimension, drilldownDimension, sortBy, sortDir, columnGroups,
    metricFilters: metricFilters as Record<string, unknown>,
    dealFilters,
    createdTimeFilter, firstTouchFilter, search,
    periodUnit, periodDimension, compareMode,
  }), [period, comparison, dealScope, clientType, grouping, metricIds, comparisonDisplay, metricDisplayModes, comparisonThreshold, productGroupMode, highlights, pinnedMetricIds, metricDecimalOverrides, metricThresholdOverrides, accentedMetricIds, barMetricIds, heatmapMetricIds, heatmapInvertedIds, colorizeMetrics, zebra, borderMode, numberAlign, accountType, drilldownDuplicate, drilldownMetricIds, dealFields, drilldownGrouped, sourceDimension, drilldownDimension, sortBy, sortDir, columnGroups, metricFilters, createdTimeFilter, firstTouchFilter, search, periodUnit, periodDimension, compareMode]);

  // Задача 2824: respectUrl=true — только для ПЕРВОГО restore на монтировании
  // (см. вызов ниже) — там URL-параметр диплинка должен победить сохранённую
  // вкладку. При явном действии пользователя (клик по другой открытой вкладке,
  // закрытие текущей — handleTabSelect/handleTabClose ниже) снапшот вкладки
  // применяется целиком БЕЗ оглядки на URL — это осознанная смена конфигурации,
  // и адрес закономерно обновится ПОД неё (URL — следствие, не помеха).
  const applyTabSnapshot = useCallback((s: ReportTabSnapshot, opts?: { respectUrl?: boolean }) => {
    const keep = (key: string) => !!opts?.respectUrl && urlHasRef.current.has(key);
    if (!keep('period')) setPeriod({ from: new Date(s.period.from), to: new Date(s.period.to) });
    if (!keep('cmp')) setComparison({ from: new Date(s.comparison.from), to: new Date(s.comparison.to) });
    if (!keep('dealScope')) setDealScope(s.dealScope as DealScope);
    if (!keep('clientType')) setClientType(s.clientType as ClientType);
    if (!keep('grouping')) setGrouping(s.grouping as Grouping);
    // metricIds — задача 2881: НЕ в URL (см. объявление состояния выше), keep()
    // сюда больше не относится — снапшот вкладки применяется безусловно, как и
    // остальные не-URL поля формата ниже.
    setMetricIds(s.metricIds ?? []);
    setFetchedMetricIds(s.metricIds ?? []);
    if (!keep('cmpDisplay')) setComparisonDisplay(s.comparisonDisplay as ComparisonDisplay);
    setMetricDisplayModes((s.metricDisplayModes ?? {}) as Record<string, ComparisonDisplay>);
    setComparisonThreshold(s.comparisonThreshold ?? 5);
    if (!keep('productGroupMode')) setProductGroupMode(s.productGroupMode as ProductGroupMode);
    setHighlights((s.highlights ?? {}) as Record<string, MetricHighlightConfig>);
    setPinnedMetricIds(s.pinnedMetricIds ?? []);
    setMetricDecimalOverrides(s.metricDecimalOverrides ?? {});
    setMetricThresholdOverrides(s.metricThresholdOverrides ?? {});
    setAccentedMetricIds(s.accentedMetricIds ?? []);
    setBarMetricIds(s.barMetricIds ?? []);
    setHeatmapMetricIds(s.heatmapMetricIds ?? []);
    setHeatmapInvertedIds(s.heatmapInvertedIds ?? []);
    setColorizeMetrics(s.colorizeMetrics ?? false);
    setZebra(s.zebra ?? false);
    setBorderMode((s.borderMode ?? 'grid') as BorderMode);
    setNumberAlign((s.numberAlign ?? 'center') as 'left' | 'center' | 'right');
    if (!keep('accountType')) setAccountType((s.accountType ?? 'managers') as 'managers' | 'logists' | 'all');
    setDrilldownDuplicate(s.drilldownDuplicate ?? true);
    setDrilldownMetricIds(s.drilldownMetricIds ?? []);
    setDealFields(s.dealFields ?? undefined);
    setDrilldownGrouped(s.drilldownGrouped ?? true);
    if (!keep('sourceDim')) setSourceDimension((s.sourceDimension ?? 'brand') as SourceDimension);
    setDrilldownDimension((s.drilldownDimension ?? 'contact_type') as DrilldownDimension);
    if (!keep('sortBy')) setSortBy(s.sortBy ?? null);
    if (!keep('sortDir')) setSortDir((s.sortDir ?? 'desc') as 'asc' | 'desc');
    setColumnGroups(s.columnGroups ?? []);
    setMetricFilters((s.metricFilters ?? {}) as MetricFilters);
    // «Фильтр сделок» — как и остальные настройки отчёта, применяется из пресета,
    // но keep() уважает уже стоящий в URL фильтр: ссылка с фильтром важнее
    // сохранённого в отчёте (человек прислал конкретный срез — показываем его).
    if (!keep('dealFilters')) setDealFilters((s.dealFilters ?? []) as DealFilter[]);
    if (!keep('createdTime')) setCreatedTimeFilter((s.createdTimeFilter ?? 'all') as CreatedTimeFilter);
    if (!keep('firstTouch')) setFirstTouchFilter((s.firstTouchFilter ?? 'all') as FirstTouchFilter);
    if (!keep('q')) setSearch(s.search ?? '');
    if (!keep('unit')) setPeriodUnit((s.periodUnit ?? 'month') as CalendarUnit);
    if (!keep('dim')) setPeriodDimension((s.periodDimension ?? 'managers') as PeriodsDimension);
    if (!keep('cmpMode')) setCompareMode((s.compareMode ?? 'prev') as CompareMode);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Смена route без ремоунта (см. шапку блока) — форсим повторный restore.
  useEffect(() => {
    tabsRestoredRef.current = false;
    setTabsStore(null);
  }, [pathname]);

  // Инициализация/restore после резолва сессии (ключ localStorage — per-login).
  useEffect(() => {
    if (tabsLogin === undefined || tabsRestoredRef.current) return;
    const store = loadTabsStore(tabsLogin);
    let active = store.tabs.find(t => t.id === store.activeId) ?? null;
    if (isNew || !active || active.route !== pathname) {
      const reusable = isNew ? null
        : (store.tabs.filter(t => t.route === pathname).sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ?? null);
      if (reusable) {
        active = reusable;
      } else {
        active = { id: newTabId(), route: pathname, name: title, state: null, lastUsedAt: Date.now() };
        store.tabs.push(active);
      }
      store.activeId = active.id;
    }
    active.lastUsedAt = Date.now();
    // respectUrl: true — единственный вызов на самом первом restore при
    // монтировании: диплинк с явным ?dealScope=/?period=/... должен победить
    // то, что было сохранено в localStorage с прошлого визита (задача 2824).
    if (active.state) applyTabSnapshot(active.state, { respectUrl: true });
    saveTabsStore(tabsLogin, store);
    setTabsStore(store);
    tabsRestoredRef.current = true;
  }, [tabsLogin, pathname, isNew, title, applyTabSnapshot]);

  // Персист состояния активной вкладки при каждом изменении (дёшево, <5КБ JSON).
  useEffect(() => {
    if (!tabsRestoredRef.current || !tabsStore || tabsLogin === undefined) return;
    const active = tabsStore.tabs.find(t => t.id === tabsStore.activeId);
    if (!active || active.route !== pathname) return;
    active.state = buildTabSnapshot();
    active.lastUsedAt = Date.now();
    saveTabsStore(tabsLogin, tabsStore);
  }, [buildTabSnapshot, tabsStore, tabsLogin, pathname]);

  function handleTabSelect(tab: ReportTab) {
    if (!tabsStore) return;
    const cur = tabsStore.tabs.find(t => t.id === tabsStore.activeId);
    // Снапшот ДО ухода — состояние отчёта И позиция скролла (задача 2947):
    // tableContainerRef в этот момент ещё указывает на DOM уходящей вкладки.
    if (cur && cur.route === pathname) {
      cur.state = buildTabSnapshot();
      cur.scrollTop = tableContainerRef.current?.scrollTop ?? cur.scrollTop;
    }
    tabsStore.activeId = tab.id;
    tab.lastUsedAt = Date.now();
    saveTabsStore(tabsLogin ?? null, tabsStore);
    if (tab.route !== pathname) {
      router.push(tab.route);
    } else {
      if (tab.state) applyTabSnapshot(tab.state);
      setTabsStore({ ...tabsStore });
    }
  }

  function handleTabAdd() {
    if (!tabsStore) return;
    const snap = buildTabSnapshot();
    const cur = tabsStore.tabs.find(t => t.id === tabsStore.activeId);
    if (cur && cur.route === pathname) {
      cur.state = snap;
      cur.scrollTop = tableContainerRef.current?.scrollTop ?? cur.scrollTop;
    }
    const tab: ReportTab = { id: newTabId(), route: pathname, name: title, state: snap, lastUsedAt: Date.now() };
    tabsStore.tabs.push(tab);
    tabsStore.activeId = tab.id;
    saveTabsStore(tabsLogin ?? null, tabsStore);
    setTabsStore({ ...tabsStore });
  }

  function handleTabClose(tab: ReportTab) {
    if (!tabsStore) return;
    const idx = tabsStore.tabs.findIndex(t => t.id === tab.id);
    if (idx === -1) return;
    const wasActive = tabsStore.activeId === tab.id;
    tabsStore.tabs.splice(idx, 1);
    if (wasActive) {
      const next = tabsStore.tabs[idx] ?? tabsStore.tabs[idx - 1] ?? null;
      if (next) {
        tabsStore.activeId = next.id;
        next.lastUsedAt = Date.now();
        saveTabsStore(tabsLogin ?? null, tabsStore);
        if (next.route !== pathname) { setTabsStore({ ...tabsStore }); router.push(next.route); return; }
        if (next.state) applyTabSnapshot(next.state);
      } else {
        // Последняя вкладка закрыта — остаёмся на текущем отчёте свежей вкладкой.
        const fresh: ReportTab = { id: newTabId(), route: pathname, name: title, state: buildTabSnapshot(), lastUsedAt: Date.now() };
        tabsStore.tabs.push(fresh);
        tabsStore.activeId = fresh.id;
        saveTabsStore(tabsLogin ?? null, tabsStore);
      }
    } else {
      saveTabsStore(tabsLogin ?? null, tabsStore);
    }
    setTabsStore({ ...tabsStore });
  }

  function handleTabRename(tab: ReportTab, name: string) {
    if (!tabsStore) return;
    tab.name = name;
    saveTabsStore(tabsLogin ?? null, tabsStore);
    setTabsStore({ ...tabsStore });
  }

  // Сравнение при смене периода теперь считает PeriodRangeControls (FilterBar.tsx —
  // задача 10.07: быстрый пресет → календарный шаг назад, ручной диапазон → хвост
  // той же длины, как раньше), через onComparisonChange={setComparison} ниже.
  const handlePeriodChange = useCallback((p: DateRange) => {
    setPeriod(p);
  }, []);

  // fetchedMetricIds only grows — removals don't trigger re-fetch, additions do
  const metricIdsForQuery = fetchedMetricIds.includes('all_core') ? ['all_core'] : [...fetchedMetricIds].sort();
  const sourceMode = reportSlug === 'by-sources';
  // «По периодам» (задача 09.08): строки — сами периоды. Свой роут (см. шапку
  // app/api/reports/by-periods/route.ts): у него другой контракт сравнения и
  // не нужна тяжёлая план/звонковая обвязка /api/reports/run.
  const periodMode = reportSlug === 'by-periods';
  // «По клиентам» (задача 10.08): строка = клиент. Группировки/группы/тип
  // аккаунта неприменимы; дрилл строки — плоский список сделок клиента.
  const clientMode = reportSlug === 'by-clients';
  const queryKey = ['report', reportSlug, period, comparison, dealScope, clientType, metricIdsForQuery, departmentIds, productGroupMode, accountType, sourceMode ? sourceDimension : null, createdTimeFilter, firstTouchFilter, dealFilters,
    periodMode ? periodUnit : null, periodMode ? periodDimension : null, periodMode ? compareMode : null];

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await fetch(periodMode ? '/api/reports/by-periods' : '/api/reports/run', {
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
          createdTimeFilter,
          firstTouchFilter,
          dealFilters: dealFilters.length ? dealFilters : undefined,
          ...(periodMode ? { unit: periodUnit, dimension: periodDimension, compareMode } : {}),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: 2 * 60 * 1000, // 2 min — prevent silent refetch on window focus
    refetchOnWindowFocus: false,
    // Не стартуем, пока не загрузился аккаунтный выбор отделов — иначе первый запрос
    // ушёл бы без фильтра и отчёт мигал нефильтрованными данными.
    enabled: departmentsReady,
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

  const dimensionType = clientMode ? 'client' : periodMode ? 'period' : sourceMode ? 'source' : reportSlug === 'by-product-groups' ? 'product-group' : 'manager';

  // Пользовательские группы (задача 2653): per-user, per-шкала (для товарных
  // групп kc/by_max несовместимы — dimensionKey включает режим).
  const userGroupsKey = dimensionType === 'product-group' ? `product-group:${productGroupMode}` : 'manager';
  const { data: userGroupsData } = useQuery<{ groups: UserReportGroup[] }>({
    queryKey: ['report-groups', userGroupsKey],
    queryFn: async () => {
      const res = await fetch(`/api/report-groups?dimensionKey=${encodeURIComponent(userGroupsKey)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    // В «По периодам» строки — бакеты времени, объединять их в пользовательские
    // группы нечего (и незачем грузить справочник групп).
    enabled: !sourceMode && !periodMode && !clientMode,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const userGroups = useMemo(() => userGroupsData?.groups ?? [], [userGroupsData]);
  // id участника → имя его группы: дизейбл чекбоксов в режиме выбора (тултип
  // «Уже в группе …») — «один участник — одна группа» (плюс серверный 409).
  const userGroupBusy = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of userGroups) for (const id of g.member_ids) m.set(id, g.name);
    return m;
  }, [userGroups]);
  // Свободные (не в группах) сущности текущего среза — участники строки
  // «Без группы»: её дрилл-даун идёт объединением по этим id (как у групп).
  const userGroupFreeIds = useMemo(
    () => (data?.rows ?? [])
      .map((r: MergedRow) => r.dimensionId)
      .filter((id: string) => !userGroupBusy.has(id)),
    [data?.rows, userGroupBusy]
  );

  // Режим создания группы чекбоксами в строках (правка Серёги 31.07 №2):
  // состояние живёт здесь (таблица и инлайн-панель — разные ветки рендера).
  const [groupSelectMode, setGroupSelectMode] = useState(false);
  const [groupSelectIds, setGroupSelectIds] = useState<Set<string>>(new Set());
  const exitGroupSelect = useCallback(() => {
    setGroupSelectMode(false);
    setGroupSelectIds(new Set());
  }, []);
  // Смена измерения (менеджеры ↔ товарные группы kc/by_max) — выбор неактуален.
  useEffect(() => { exitGroupSelect(); }, [userGroupsKey, exitGroupSelect]);

  const displayRows = useMemo(() => {
    // Пользовательские группы (задача 2653, этап 2 — работают при ЛЮБОЙ
    // группировке): участники заранее схлопнуты в синтетические строки, поэтому
    // подытоги отделов/филиалов их НЕ задваивают (участник живёт только внутри
    // строки группы). Строка группы с общим отделом/филиалом остаётся внутри
    // него; «сборная» из разных — поднимается на верхний уровень с пометкой.
    let grouped: GroupedMergedRow[];
    if (!sourceMode && !periodMode && !clientMode && userGroups.length > 0) {
      // «Без группы» — только при grouping='none' (решение выше, у applyUserGroups).
      const applied = applyUserGroups(data?.rows ?? [], userGroups, catalogMetrics, grouping === 'none');
      if (grouping === 'none' || grouping === 'total') {
        grouped = grouping === 'none' ? applied : applyClientGrouping(applied, grouping, catalogMetrics);
      } else {
        const fits = (r: GroupedMergedRow) =>
          !r.dimensionId.startsWith('__ugroup__')
          || (grouping === 'team' ? r.teamId !== null : r.branchName !== null);
        const inRows = applied.filter(fits);
        const hoisted = applied
          .filter(r => !fits(r))
          .map(r => ({ ...r, dimensionName: `${r.dimensionName} · сборная` }));
        grouped = [...hoisted, ...applyClientGrouping(inRows, grouping, catalogMetrics)];
      }
    } else {
      grouped = applyClientGrouping(data?.rows ?? [], grouping, catalogMetrics);
    }
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
  }, [data?.rows, grouping, search, catalogMetrics, sourceMode, userGroups]);

  // Общее число отделов — только для диагноз-пилюли составного empty state (задача
  // 1698, кейс 10Б). Тот же queryKey, что у DepartmentPicker внутри FilterBar — React
  // Query дедуплицирует запрос, второго похода в сеть не будет.
  const { data: orgStructureData } = useQuery({
    queryKey: ['org-structure'],
    queryFn: () => fetch('/api/catalog/org-structure').then(r => r.json()),
    staleTime: 5 * 60 * 1000,
  });
  const totalDepartments = useMemo(
    () => orgStructureData?.tree ? countAllDepartmentIds(orgStructureData.tree) : undefined,
    [orgStructureData]
  );

  // «Сбросить фильтры» из empty state (задача 1698, кейс 10Б): сбрасывает поиск —
  // это обязательный минимум (именно поиск обычно и даёт 0 строк, см. мокап) — и
  // фильтры сделок, которые реально отсекают строки (тип сделки/клиента,
  // «нерабочее время», цветовой фильтр метрики). НЕ трогает период и выбранные
  // метрики (явно запрещено брифом) и НЕ трогает departmentIds — отделы спорно
  // считать «фильтром отчёта» (это скорее срез, чем фильтр очистки; сброс молча
  // расширил бы выборку на отделы, которые пользователь мог убрать намеренно) —
  // решение отмечено в отчёте задачи, при необходимости расширить это отдельная
  // правка с явным подтверждением владельца.
  const handleResetReportFilters = useCallback(() => {
    setSearch('');
    setDealScope('all');
    setClientType('all');
    setCreatedTimeFilter('all');
    setFirstTouchFilter('all');
    setMetricFilters({});
  }, []);

  const handleRowClick = useCallback(
    (id: string, name: string) => {
      // Агрегированные строки отделов внутри филиала → сделки отдела
      if (id.startsWith('__ugroup__')) {
        // Этап 2 (задача 2653): список сделок ВСЕХ участников группы —
        // объединение по managerIds/productGroups (паттерн дрилла отделов).
        const g = userGroups.find(x => `__ugroup__${x.id}` === id);
        if (!g) return;
        setDrilldown({ id: g.member_ids.join(','), name, kind: dimensionType === 'manager' ? 'managers' : 'productGroups' });
        return;
      }
      if (id.startsWith('__team__')) setDrilldown({ id: id.slice('__team__'.length), name, kind: 'team' });
      else if (id.startsWith('__branch__')) setDrilldown({ id: id.slice('__branch__'.length), name, kind: 'branch' });
      else setDrilldown({ id, name });
    },
    // userGroups/dimensionType — дрилл пользовательских групп (задача 2653, этап 2)
    [userGroups, dimensionType]
  );

  // Клик по #логину менеджера (dimensionSubtitle) — только в отчёте «по менеджерам»
  // (в остальных отчётах ReportTable либо не получает onSubtitleClick вовсе, либо
  // dimensionSubtitle означает что-то другое — см. проп в ReportTable.tsx).
  // Карточка 10.0 (задача владельца 29.07): панель заменена страницей /manager/[id];
  // период отчёта передаётся через query, чтобы ЛК открылся на том же периоде.
  const handleSubtitleClick = useCallback(
    (id: string, name: string) => {
      const qs = new URLSearchParams({
        name,
        from: period.from.toISOString(),
        to: period.to.toISOString(),
      });
      router.push(`/manager/${id}?${qs}`);
    },
    [router, period]
  );

  const handleCellClick = useCallback(
    (id: string, name: string, metricId: string) => {
      const m = catalogMetrics.find((x: { id: string }) => x.id === metricId)
        ?? availableMetrics.find((x: { id: string }) => x.id === metricId);
      // Групповые строки и «Итого» открывают плоский список сделок всего среза
      if (id.startsWith('__ugroup__')) {
        // «Без группы» (31.07 №1): дрилл по объединению всех свободных сущностей —
        // тот же механизм managerIds/productGroups, что у обычных user-групп.
        const memberIds = id === NOGROUP_ROW_ID
          ? userGroupFreeIds
          : userGroups.find(x => `__ugroup__${x.id}` === id)?.member_ids ?? [];
        if (memberIds.length === 0) return;
        setDrilldown({ id: memberIds.join(','), name, metricId, metricName: m?.nameRu, kind: dimensionType === 'manager' ? 'managers' : 'productGroups' });
        return;
      }
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
    [catalogMetrics, availableMetrics, userGroups, userGroupFreeIds, dimensionType]
  );

  // «График из отчёта» (фича Серёги 01.08): открыть график динамики метрики для
  // строки/группы/«Итого». Чтобы график ГАРАНТИРОВАННО бился с ячейкой, ограничение
  // строки передаётся ЯВНО: by-managers — список manager-id (для отдела/филиала/
  // пользовательской группы/Итого — участники видимого отчёта: так же учитываются
  // отделы и тип аккаунта, отфильтрованные на этом слое); by-product-groups —
  // товарная группа строки (тот же buildProductGroupFilter на сервере).
  const handleMetricChart = useCallback(
    (id: string, name: string, metricId: string) => {
      const findRow = (rs: GroupedMergedRow[]): MergedRow | undefined => {
        for (const r of rs) {
          if (r.dimensionId === id) return r;
          if (r.children) { const c = findRow(r.children as GroupedMergedRow[]); if (c) return c; }
        }
        return undefined;
      };
      const cellValue = id === '__total__'
        ? (data?.totals?.[metricId]?.current ?? null)
        : (findRow(displayRows as GroupedMergedRow[])?.deltas?.[metricId]?.current ?? null);
      let managerIds: string[] | undefined;
      let pgRowId: string | undefined;
      const baseRows: MergedRow[] = (data?.rows ?? []) as MergedRow[];
      if (clientMode) {
        if (id !== '__total__') {
          alert('График по строке-клиенту пока не поддержан — используйте иконку в заголовке метрики («Итого»)');
          return;
        }
      } else if (periodMode) {
        // Строка — сам период: график «динамика одного месяца» смысла не имеет,
        // вся таблица УЖЕ является этой динамикой. Для «Итого» — обычный график
        // метрики за весь диапазон отчёта.
        if (id !== '__total__') {
          alert('Строка этого отчёта — сам период; график динамики есть в заголовке метрики («Итого»)');
          return;
        }
      } else if (sourceMode) {
        // Разрез источников: строка ≠ менеджер/группа — поддержан только «Итого»
        // (фильтры источников в серию пока не транслируются — осознанное ограничение v1).
        if (id !== '__total__') { alert('График по строкам источников пока не поддержан — используйте иконку в заголовке метрики («Итого»)'); return; }
      } else if (reportSlug === 'by-managers') {
        if (id === '__total__') managerIds = baseRows.map(r => r.dimensionId);
        else if (id.startsWith('__team__')) { const t = id.slice(8); managerIds = baseRows.filter(r => (r.teamId ?? '__no_team__') === t).map(r => r.dimensionId); }
        else if (id.startsWith('__branch__')) { const b = id.slice(10); managerIds = baseRows.filter(r => (r.branchName ?? 'СПб') === b).map(r => r.dimensionId); }
        else if (id === NOGROUP_ROW_ID) managerIds = userGroupFreeIds;
        else if (id.startsWith('__ugroup__')) managerIds = userGroups.find(x => `__ugroup__${x.id}` === id)?.member_ids ?? [];
        else managerIds = [id];
        if (managerIds !== undefined && managerIds.length === 0) return;
      } else if (reportSlug === 'by-product-groups') {
        if (id !== '__total__' && !id.startsWith('__')) {
          // kc: '__none__' уже в id; by_max: строковое имя head-группы (включая «Без группы»).
          pgRowId = productGroupMode === 'by_max' && id === 'Без группы' ? 'Без группы' : id;
        } else if (id !== '__total__') {
          return; // групповые строки этого разреза графику пока не учим
        }
      }
      setChartTarget({ metricId, dimensionId: id, dimensionName: name, managerIds, productGroupId: pgRowId, cellValue });
    },
    [data?.rows, data?.totals, displayRows, reportSlug, sourceMode, periodMode, productGroupMode, userGroups, userGroupFreeIds],
  );

  // Экспорт отчёта (задача 1706): буфер (TSV)/Excel/PDF/PNG — единый снимок таблицы
  // (buildExportTable, features/reports/lib/tableExport.ts) форматирует значения ПО ТИПУ
  // МЕТРИКИ (percent/money/...), один источник форматирования на все 4 способа
  // экспорта — раньше «Копировать» форматировал проценты как «человеческое» число
  // (14.5), из-за чего в Excel с процентным форматом ячейки оно домножалось ещё раз на
  // 100 (1450%). Теперь проценты — доля (0.145) везде.
  // Окно дрилл-дауна в отчёте «По периодам»: границы самого бакета, обрезанные
  // периодом отчёта (крайний бакет бывает неполным — тогда и в ячейке, и в списке
  // сделок должна быть одна и та же часть месяца). Сравнение — ПОЛНЫЙ сдвинутый
  // бакет, ровно та же база, что у колонки «Пред.» в строке (см. роут by-periods).
  const drilldownPeriod = useMemo(() => {
    if (!periodMode || !drilldown || !/^\d{4}-\d{2}-\d{2}$/.test(drilldown.id)) return null;
    const b = bucketRange(drilldown.id, periodUnit);
    return {
      from: b.from > period.from ? b.from : period.from,
      to: b.to < period.to ? b.to : period.to,
    };
  }, [periodMode, drilldown, periodUnit, period]);
  const drilldownComparison = useMemo(() => {
    if (!periodMode || !drilldown || !/^\d{4}-\d{2}-\d{2}$/.test(drilldown.id)) return null;
    const cmp = comparisonBucketOf(drilldown.id, periodUnit, compareMode);
    return cmp ? bucketRange(cmp, periodUnit) : null;
  }, [periodMode, drilldown, periodUnit, compareMode]);

  const dimensionColumnLabel = clientMode
    ? 'Клиент'
    : periodMode
    ? 'Период'
    : sourceMode
    ? (SOURCE_DIMENSION_LABELS[sourceDimension] ?? 'Источник')
    : reportSlug === 'by-product-groups' ? 'Товарная группа' : 'Менеджер';

  // Ref на корневой прокручиваемый div таблицы (ReportTable.tsx) — нужен PNG/PDF-снимку
  // (captureTableNode временно разворачивает его в overflow:visible на время снимка,
  // чтобы захватить ВЕСЬ скроллируемый контент длинного отчёта, не только вьюпорт).
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // Восстановление позиции скролла при переключении вкладок отчётов (задача
  // 2947, П2.12): захват — в handleTabSelect/handleTabAdd (ДО ухода со
  // вкладки, пока containerRef ещё смотрит на её DOM). Здесь — только
  // восстановление, один раз на каждую активацию вкладки, и не раньше, чем
  // данные новой вкладки догрузились (иначе scrollHeight ещё не тот и
  // scrollTop молча схлопнется в 0). lastScrollRestoredForRef — защита от
  // повторной перемотки на ту же сохранённую позицию при каждом ре-рендере
  // (иначе любая последующая прокрутка пользователем внутри той же вкладки
  // откатывалась бы назад).
  const lastScrollRestoredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tabsStore || isFetching) return;
    const active = tabsStore.tabs.find(t => t.id === tabsStore.activeId);
    if (!active || lastScrollRestoredForRef.current === active.id) return;
    lastScrollRestoredForRef.current = active.id;
    const node = tableContainerRef.current;
    if (!node) return;
    const target = active.scrollTop ?? 0;
    node.scrollTop = target;
    // Тот же приём, что и restore скролла между вкладками ЛК
    // (ManagerCardPage.tsx) — живая проверка на dev-стенде задачи 2947
    // показала, что даже после !isFetching таблица иногда дорастает по
    // высоте на кадр позже (виртуализация строк/поздний layout), и scrollTop
    // клэмпится ниже сохранённого. Переприменяем ещё несколько кадров.
    let frames = 0;
    const raf = () => {
      if (frames++ > 15 || !tableContainerRef.current) return;
      const n = tableContainerRef.current;
      if (n.scrollTop < target && n.scrollHeight - n.clientHeight >= target) n.scrollTop = target;
      requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
  }, [tabsStore, isFetching]);

  const buildCurrentExportTable = useCallback(() => {
    return buildExportTable({
      dimensionLabel: dimensionColumnLabel,
      metrics: orderedMetrics as Metric[],
      rows: displayRows as unknown as ExportSourceRow[],
      totals: (data?.totals ?? null) as ExportTotals | null,
      grouping,
      metricDecimalOverrides,
    });
  }, [dimensionColumnLabel, orderedMetrics, displayRows, data?.totals, grouping, metricDecimalOverrides]);

  const exportFilenameBase = useMemo(
    () => buildExportFilename(title, period),
    [title, period]
  );

  const handleCopyTable = useCallback(async () => {
    const table = buildCurrentExportTable();
    await navigator.clipboard.writeText(tableToTsv(table));
  }, [buildCurrentExportTable]);

  const handleExportExcel = useCallback(async () => {
    const table = buildCurrentExportTable();
    await exportTableToExcel(table, exportFilenameBase);
  }, [buildCurrentExportTable, exportFilenameBase]);

  const handleExportPng = useCallback(async () => {
    const node = tableContainerRef.current;
    if (!node) throw new Error('Таблица ещё не отрисована');
    await exportNodeToPng(node, exportFilenameBase);
  }, [exportFilenameBase]);

  const handleExportPdf = useCallback(async () => {
    const node = tableContainerRef.current;
    if (!node) throw new Error('Таблица ещё не отрисована');
    await exportNodeToPdf(node, exportFilenameBase);
  }, [exportFilenameBase]);

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
      {tabsStore && (
        <ReportTabsBar
          tabs={tabsStore.tabs}
          activeId={tabsStore.activeId}
          onSelect={handleTabSelect}
          onClose={handleTabClose}
          onAdd={handleTabAdd}
          onRename={handleTabRename}
        />
      )}
      <div className="px-6 pt-4 pb-2 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)]">
        {renamingTitle ? (
          <input
            autoFocus
            value={titleValue}
            onChange={e => setTitleValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitTitleRename();
              if (e.key === 'Escape') { setRenamingTitle(false); setTitleValue(title); }
            }}
            onBlur={commitTitleRename}
            className="text-lg font-semibold text-[var(--color-text)] bg-[var(--color-bg)] border border-[var(--color-accent)] rounded-[7px] px-2 py-0.5 outline-none w-full max-w-md"
          />
        ) : (
          <div className="group inline-flex items-center gap-2">
            <h1 className="text-lg font-semibold text-[var(--color-text)]">{title}</h1>
            {/* Кнопки переименования/удаления — задача 1605, финальное решение
                владельца: карандаш+корзинка убраны из сайдбара, живут тут, по
                hover на заголовок открытого отчёта. Стиль — квадратные кнопки
                с рамкой из шапки колонок таблицы (ReportTable.tsx, полоска
                настроек метрики: rounded-[7px] border, сегменты с общим
                бордером) — тот же паттерн, что раньше применялся в сайдбаре. */}
            {canManageReport && (
              <div className="hover-reveal flex items-stretch h-6 rounded-[7px] border border-[var(--color-border)] bg-[var(--color-bg-surface)] overflow-hidden shadow-[0_1px_2px_rgba(33,37,41,0.06)]">
                <button
                  onClick={() => setRenamingTitle(true)}
                  className="w-7 flex-shrink-0 flex items-center justify-center border-r border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-accent)] transition-colors"
                  title="Переименовать"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={handleDeleteReport}
                  className="w-7 flex-shrink-0 flex items-center justify-center text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-negative)] transition-colors"
                  title="Удалить"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Плашка расхождения (задача 2881): текущий вид отличается от того, что
          сохранено в БД для этого отчёта — снапшот вкладки в localStorage
          (reportTabs.ts) по замыслу побеждает пресет на каждом монтировании,
          и без этой строки пользователь не понимает, ПОЧЕМУ. Спокойный
          информационный тон (тот же warning-токен, что «заявка у руководителя»
          в ManagerTabs.tsx — не алярм-красный), один ряд на десктопе; на узких
          экранах текст и кнопка переносятся друг под друга, не обрезаются и не
          вылезают за край (проверено на 375px). */}
      {isSavedPreset && presetDiff.length > 0 && (
        <div
          role="status"
          className="flex flex-col sm:flex-row sm:items-center gap-x-3 gap-y-1.5 px-4 sm:px-6 py-2 border-b text-[13px] leading-snug"
          style={{
            borderColor: 'color-mix(in srgb, var(--color-warning, #e8590c) 30%, transparent)',
            backgroundColor: 'color-mix(in srgb, var(--color-warning, #e8590c) 8%, transparent)',
          }}
        >
          <span className="flex items-center gap-1.5 min-w-0 text-[var(--color-text)]">
            <Info size={14} style={{ color: 'var(--color-warning, #e8590c)' }} className="shrink-0" />
            Вид изменён относительно сохранённого отчёта
          </span>
          <button
            onClick={handleResetToPreset}
            title={`Отличается: ${presetDiff.join(', ')}`}
            className="self-start sm:self-auto sm:ml-auto shrink-0 font-medium text-[var(--color-accent)] hover:underline"
          >
            Вернуть исходный вид
          </button>
        </div>
      )}

      {(() => {
        const filterBarProps = {
          period, comparison, departmentIds, search,
          // Группировки по отделам/филиалам у строк-периодов нет: подытог «отдела»
          // внутри месяца — это уже другой отчёт (в него и ведёт дрилл бакета).
          grouping: sourceMode || periodMode || clientMode ? undefined : grouping,
          onPeriodChange: handlePeriodChange,
          onComparisonChange: setComparison,
          onDepartmentIdsChange: setDepartmentIds,
          onSearchChange: setSearch,
          onGroupingChange: sourceMode || periodMode || clientMode ? undefined : setGrouping,
          showDepartments: !sourceMode,
          // «По периодам»: второго диапазона нет — база сравнения построчная
          // (переключатель «Сравнение» в шапке отчёта, PeriodReportControls).
          showComparison: !periodMode,
          sourceDimension: sourceMode ? sourceDimension : undefined,
          onSourceDimensionChange: sourceMode ? setSourceDimension : undefined,
          // Кнопка настройки метрик доступна в обоих режимах (задача 1564: вернуть в
          // «Обычной» — раньше скрывалась вместе с остальными pro-only элементами по
          // п.3а спеки, но состав/подсветку метрик нужно менять и без Pro).
          onOpenMetricPanel: () => setShowMetricPanel(true),
          metricsBadge: metricIds.includes('all_core') ? Object.keys(highlights).length : metricIds.length,
        };

        const reportToolbarProps = {
          dealScope,
          comparisonDisplay,
          hasMixedDisplay,
          onDealScopeChange: setDealScope,
          clientType,
          onClientTypeChange: setClientType,
          onComparisonDisplayChange: (v: ComparisonDisplay) => { setComparisonDisplay(v); setMetricDisplayModes({}); },
          onRefresh: () => refetch(),
          isLoading: isFetching,
          viewPrefs,
          onViewPrefsChange: updateViewPrefs,
          numberAlign,
          onNumberAlignChange: setNumberAlign,
          accountType,
          // Тип аккаунта режет сделки по менеджеру — значит имеет смысл там, где
          // строка (или разрез дрилла) менеджерская.
          onAccountTypeChange: reportSlug === 'by-managers' || (periodMode && periodDimension === 'managers')
            ? setAccountType : undefined,
          drilldownGrouped,
          onDrilldownGroupedChange: setDrilldownGrouped,
          colorizeMetrics,
          onColorizeMetricsChange: setColorizeMetrics,
          zebra,
          onZebraChange: setZebra,
          borderMode,
          onBorderModeChange: setBorderMode,
          showProductGroupPicker: true,
          productGroupMode,
          onProductGroupModeChange: setProductGroupMode,
          createdTimeFilter,
          onCreatedTimeFilterChange: setCreatedTimeFilter,
          firstTouchFilter,
          onFirstTouchFilterChange: setFirstTouchFilter,
          onSaveReport: () => setShowSaveModal(true),
          onCopyTable: handleCopyTable,
          onExportExcel: handleExportExcel,
          onExportPdf: handleExportPdf,
          onExportPng: handleExportPng,
          basic: !isPro,
          // Задача 2990: «Сохранить» — базовая функция, ReportToolbar её больше не
          // гейтит по basic ни при каких условиях. forceShowSave оставлен только
          // как обратно-совместимый проп (no-op), остальные pro-only элементы
          // тулбара (Настройки отчёта/Сравнение) basic по-прежнему скрывает.
          forceShowSave: isNew,
          onOpenComparison: () => setShowComparison(true),
          comparisonCount: compareIds.length,
          // «Создать группу» в одном ряду с «Настройки отчёта»/«Сравнение»
          // (правка Серёги 31.07); в source-режиме группы не поддерживаются.
          // Кнопка — тумблер режима выбора чекбоксами (31.07 №2).
          // «Фильтр сделок» (задача владельца 07.08) — тем же слотом, рядом со
          // «Сравнением» и «Создать группу», как он и просил. В source-режиме
          // тоже доступен: фильтр режет сделки, а не сущности строк.
          userGroupsSlot: (
            <>
              <DealFilterButton value={dealFilters} onChange={setDealFilters} />
              {!sourceMode && !periodMode && !clientMode && (
                <CreateGroupButton
                  active={groupSelectMode}
                  onClick={() => (groupSelectMode ? exitGroupSelect() : setGroupSelectMode(true))}
                />
              )}
            </>
          ),
        };

        // Задача 1714 (мобильный тулбар, <768px): владелец прислал скрин — управление
        // отчётом занимало ~75% высоты экрана на телефоне, таблице оставалось 2 строки.
        // На мобиле FilterBar+ReportToolbar (две строки контролов) заменяются ОДНИМ
        // компактным MobileReportBar (период + «Фильтры» с бейджем, остальное — в
        // выдвижной панели) — те же пропсы, тот же state в SalesReportPage, десктоп
        // (≥768px) рендерит прежние FilterBar+ReportToolbar без изменений.
        return isMobile ? (
          <MobileReportBar {...filterBarProps} {...reportToolbarProps} />
        ) : (
          <>
            <FilterBar {...filterBarProps} />
            <ReportToolbar {...reportToolbarProps} />
          </>
        );
      })()}

      {/* Шапка отчёта «По периодам» (задача 09.08): шаг группировки, разрез дрилла
          и база сравнения — три контрола, которых нет у остальных отчётов. */}
      {periodMode && (
        <PeriodReportControls
          unit={periodUnit}
          onUnitChange={setPeriodUnit}
          dimension={periodDimension}
          onDimensionChange={setPeriodDimension}
          compareMode={compareMode}
          onCompareModeChange={setCompareMode}
          bucketCount={data?.meta?.bucketCount}
          unsupportedNames={((data?.unsupported ?? []) as string[]).map((id: string) =>
            (catalogMetrics.find((m: { id: string }) => m.id === id) as Metric | undefined)?.nameRu ?? id)}
        />
      )}

      {/* Плашка активного «Фильтра сделок» (задача 07.08). Фильтр режет весь
          отчёт и живёт в URL/сохранённом отчёте — значит его легко не заметить и
          решить, что упали продажи. Показываем условия словами прямо над
          таблицей, со сбросом в один клик. */}
      {dealFilters.length > 0 && (
        <div className="mx-3 sm:mx-6 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2 text-xs"
          style={{
            borderColor: 'color-mix(in srgb, var(--color-accent) 40%, transparent)',
            backgroundColor: 'color-mix(in srgb, var(--color-accent) 8%, transparent)',
          }}>
          <Filter size={13} className="shrink-0 text-[var(--color-accent)]" />
          <span className="font-semibold text-[var(--color-text)]">Отчёт построен не по всем сделкам:</span>
          <span className="min-w-0 text-[var(--color-text-muted)]">{describeDealFilters(dealFilters).join(' · ')}</span>
          <button type="button" onClick={() => setDealFilters([])}
            className="tap-target ml-auto shrink-0 font-semibold text-[var(--color-accent)] hover:underline">
            Сбросить
          </button>
        </div>
      )}

      {isNew && selectedMetricIds.length === 0 && (
        <div className="mx-6 mt-3 flex flex-col sm:flex-row sm:items-center gap-2.5 sm:gap-3 rounded-lg border border-dashed border-[var(--color-accent)] bg-[var(--color-bg-surface)] px-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-[var(--color-text)]">Добавьте метрики</div>
            <div className="text-xs text-[var(--color-text-muted)]">
              Отчёт пока пустой — сейчас видна только колонка «{dimensionColumnLabel}». Выберите показатели через «Метрики» выше.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowMetricPanel(true)}
            className="tap-target shrink-0 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-[var(--color-accent)] text-[var(--color-text-inverse)] hover:opacity-90 transition-opacity"
          >
            Добавить метрики
          </button>
        </div>
      )}

      {/* Кнопка «Создать группу» переехала в ряд тулбара (userGroupsSlot, правка
          Серёги 31.07) — тут бейджи созданных групп и инлайн-панель режима выбора. */}
      {!sourceMode && groupSelectMode && (
        <GroupSelectPanel
          dimensionKey={userGroupsKey}
          selectedIds={[...groupSelectIds]}
          entityLabel={dimensionType === 'manager' ? 'менеджеров' : 'товарные группы'}
          onCancel={exitGroupSelect}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ['report-groups', userGroupsKey] });
            exitGroupSelect();
          }}
        />
      )}
      {!sourceMode && (
        <UserGroupsBar dimensionKey={userGroupsKey} groups={userGroups} />
      )}

      <div className="flex-1 overflow-hidden">
        {error ? (
          <div className="p-6 text-[var(--color-negative)] text-sm">
            Ошибка: {error instanceof Error ? error.message : 'Неизвестная ошибка'}
          </div>
        ) : (
          <ReportTable
            containerRef={tableContainerRef}
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
            onMetricChart={handleMetricChart}
            // Режим создания группы чекбоксами (31.07 №2): чекбоксы у реальных
            // строк (не у синтетических __*); занятые — disabled с тултипом.
            rowSelection={groupSelectMode ? {
              checked: groupSelectIds,
              busy: userGroupBusy,
              onToggle: (id: string) => setGroupSelectIds(prev => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
              }),
            } : undefined}
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
            emptyStateInfo={{
              period,
              search,
              departmentIds,
              totalDepartments,
              onResetFilters: handleResetReportFilters,
            }}
          />
        )}
      </div>

      {chartTarget && (() => {
        const cm = (catalogMetrics.find((x: { id: string }) => x.id === chartTarget.metricId)
          ?? availableMetrics.find((x: { id: string }) => x.id === chartTarget.metricId)) as Metric | undefined;
        if (!cm) return null;
        return (
          <MetricChartModal
            target={chartTarget}
            metric={cm}
            reportSlug={reportSlug}
            period={period}
            comparison={comparison}
            hasComparison={comparisonDisplay !== 'current'}
            filters={{ dealScope, clientType, productGroupMode, createdTimeFilter, firstTouchFilter }}
            onClose={() => setChartTarget(null)}
          />
        );
      })()}
      {drilldown && (
        <DrilldownDrawer
          key={`${drilldown.id}:${drilldown.metricId ?? ''}`}
          target={drilldown}
          dimensionType={dimensionType}
          periodDimension={periodMode ? periodDimension : undefined}
          // «По периодам»: цель дрилла — бакет, поэтому в ящик уходит окно САМОГО
          // бакета, а не весь период отчёта. Дальше всё работает существующими
          // движками: мини-отчёт по менеджерам/товарным группам и списки сделок
          // просто считаются за узкое окно. Границы обрезаются периодом отчёта —
          // иначе у неполного крайнего бакета список сделок был бы шире цифры
          // в ячейке (в ячейке — только часть месяца, попавшая в период).
          period={drilldownPeriod ?? period}
          comparison={drilldownComparison ?? comparison}
          dealScope={dealScope}
          clientType={clientType}
          productGroupMode={productGroupMode}
          metricIds={drilldownDuplicate || drilldownMetricIds.length === 0 ? metricIds : drilldownMetricIds}
          departmentIds={departmentIds}
          accountType={accountType}
          dealFields={dealFields}
          dealFilters={dealFilters}
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
          periodUnit={periodMode ? periodUnit : undefined}
          periodDimension={periodMode ? periodDimension : undefined}
          compareMode={periodMode ? compareMode : undefined}
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
