// Вкладки отчётов «как в браузере» (фича Серёги 01.08): эфемерные рабочие
// вкладки раздела отчётов. Хранение — ТОЛЬКО localStorage per-user (осознанно
// НЕ БД и НЕ «избранное»: мотив — «настроить отчёт и вернуться, не сохраняя
// навсегда»); переживают перезагрузку страницы и повторный логин в том же
// браузере. Сохранение в избранное — прежней кнопкой «Сохранить».
//
// Модель: вкладка = экземпляр отчёта со СВОИМ полным состоянием (тип отчёта =
// route страницы, период, сравнение, фильтры, группировка, метрики, сортировка
// и пр. — сериализованный снапшот). Рендерится ТОЛЬКО активная вкладка (каждая
// страница отчёта монтирует один SalesReportPage) — неактивные живут как JSON,
// живых запросов не держат.

export interface ReportTabSnapshot {
  period: { from: string; to: string };
  comparison: { from: string; to: string };
  dealScope: string;
  clientType: string;
  grouping: string;
  metricIds: string[];
  comparisonDisplay: string;
  metricDisplayModes: Record<string, string>;
  comparisonThreshold: number;
  productGroupMode: string;
  highlights: Record<string, unknown>;
  pinnedMetricIds: string[];
  metricDecimalOverrides: Record<string, number>;
  metricThresholdOverrides: Record<string, number>;
  accentedMetricIds: string[];
  barMetricIds: string[];
  heatmapMetricIds: string[];
  heatmapInvertedIds: string[];
  colorizeMetrics: boolean;
  zebra: boolean;
  borderMode: string;
  numberAlign: string;
  accountType: string;
  drilldownDuplicate: boolean;
  drilldownMetricIds: string[];
  dealFields?: string[];
  drilldownGrouped: boolean;
  sourceDimension: string;
  drilldownDimension: string;
  sortBy: string | null;
  sortDir: string;
  columnGroups: { name: string; metricIds: string[] }[];
  metricFilters: Record<string, unknown>;
  /** «Фильтр сделок» (задача 07.08) — условия, режущие набор сделок отчёта. */
  dealFilters: unknown[];
  createdTimeFilter: string;
  firstTouchFilter: string;
  search: string;
  /** Отчёт «По периодам» (задача 09.08): шаг группировки, разрез дрилла и база
   *  сравнения. Опциональны — вкладки, сохранённые до появления отчёта, читаются
   *  без миграции (дефолты подставляет applyTabSnapshot). */
  periodUnit?: string;
  periodDimension?: string;
  compareMode?: string;
}

export interface ReportTab {
  id: string;
  /** route страницы отчёта: /sales/by-managers, /sales/saved/<id>, /marketing/<preset> */
  route: string;
  /** имя вкладки; дефолт — название отчёта/шаблона, редактируется по dblclick */
  name: string;
  state: ReportTabSnapshot | null;
  lastUsedAt: number;
  /**
   * Позиция вертикального скролла таблицы отчёта (задача 2947, П2.12 плана
   * мобильной готовности — «вернулся на вкладку, оказался там же»). Не часть
   * ReportTabSnapshot сознательно: это не конфигурация отчёта, а чисто
   * навигационная память «как в браузере», как lastUsedAt. Пишется в
   * SalesReportPage.tsx ПЕРЕД уходом с вкладки (handleTabSelect/handleTabAdd),
   * читается один раз после того, как данные новой вкладки догрузились.
   */
  scrollTop?: number;
}

export interface ReportTabsStore {
  activeId: string | null;
  tabs: ReportTab[];
}

const MAX_TABS = 20;

function storageKey(login: string | null): string {
  return `analsteroid:report-tabs:v1:${login ?? 'anon'}`;
}

export function newTabId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function loadTabsStore(login: string | null): ReportTabsStore {
  if (typeof window === 'undefined') return { activeId: null, tabs: [] };
  try {
    const raw = window.localStorage.getItem(storageKey(login));
    if (!raw) return { activeId: null, tabs: [] };
    const parsed = JSON.parse(raw) as ReportTabsStore;
    if (!parsed || !Array.isArray(parsed.tabs)) return { activeId: null, tabs: [] };
    return { activeId: parsed.activeId ?? null, tabs: parsed.tabs.filter(t => t && t.id && t.route) };
  } catch {
    return { activeId: null, tabs: [] };
  }
}

export function saveTabsStore(login: string | null, store: ReportTabsStore): void {
  if (typeof window === 'undefined') return;
  try {
    // Кап на кол-во вкладок — страховка от разрастания localStorage.
    const tabs = store.tabs.length > MAX_TABS
      ? [...store.tabs].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, MAX_TABS)
      : store.tabs;
    window.localStorage.setItem(storageKey(login), JSON.stringify({ activeId: store.activeId, tabs }));
  } catch {
    // квота/приватный режим — вкладки просто не переживут перезагрузку
  }
}
