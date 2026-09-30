import type { Metric } from '../metrics/types';
import type { SummaryRow } from './metrics';
import { CALL_METRICS, CALL_COLUMN_GROUP } from './callMetrics';

// «Сводка по логистам» и «Регионы» на общем движке отчётов (задача #8126, аудит
// Полины, находки 7, 10, 11, 18): slug'и ниже идут через /api/reports/run →
// SalesReportPage/ReportTable — тот же тулбар, период по умолчанию, сравнение,
// выгрузка, сохранение, сортировка в URL, закреплённая колонка и «Итого».
//
// Формулы НЕ меняются: значения берутся из той же buildSummary (lib/realizations/
// metrics.ts, предложение Софьи #7971), здесь только раскладка SummaryRow по
// метрикам и человеческие подписи/описания (без кодов «М1…М12» и «integrity_ok»).
// Доли объявлены calculated-формулами над служебными счётчиками — так подытог
// группы (регион) пересчитывается честно, а не суммой процентов; значения строк
// при этом совпадают с buildSummary один в один.
export const LOGISTS_SLUG = 'realizations-logists';
export const REGIONS_SLUG = 'realizations-regions';
export const REALIZATION_SLUGS: string[] = [LOGISTS_SLUG, REGIONS_SLUG];
export const LOGIST_CATEGORY = 'Реализация: логисты';

type Def = Pick<Metric, 'id' | 'nameRu' | 'nameShortRu' | 'dataType' | 'decimalPlaces' | 'aggregationFn' | 'description'>
  & Partial<Pick<Metric, 'metricType' | 'formula' | 'dependencies' | 'isHiddenInUi'>>
  & { get: (r: SummaryRow) => number | null };

const PRELIM = ' Предварительно: методика маржи ещё не согласована.';
const onTimeN = (r: SummaryRow) => (r.onTimePct === null ? 0 : Math.round((r.onTimePct * r.shipWithHist) / 100));
const fixN = (r: SummaryRow) => (r.fixPct === null ? 0 : Math.round((r.fixPct * r.shipped) / 100));

const DEFS: Def[] = [
  // ── Заявки ──
  { id: 'lg_total', nameRu: 'Заявок', nameShortRu: 'Всего', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', get: r => r.total,
    description: 'Заявки, у которых плановая дата отгрузки попадает в период. Дубли заявки (тот же номер у того же покупателя) считаются один раз.' },
  { id: 'lg_shipped', nameRu: 'Отгружено', nameShortRu: 'Отгружено', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', get: r => r.shipped,
    description: 'Из заявок периода — в статусе «Отгружено» или «Выполнено».' },
  { id: 'lg_cancelled', nameRu: 'Отменено', nameShortRu: 'Отмена', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', get: r => r.cancelled,
    description: 'Из заявок периода — отменённые.' },
  { id: 'lg_in_work', nameRu: 'В работе', nameShortRu: 'В работе', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', get: r => r.inWork,
    description: 'Из заявок периода — ещё не отгружены и не отменены.' },
  { id: 'lg_cancel_pct', nameRu: 'Доля отмен', nameShortRu: 'Отмен, %', dataType: 'percent', decimalPlaces: 1, aggregationFn: 'avg', get: r => r.cancelPct,
    metricType: 'calculated', formula: '[lg_cancelled] / [lg_total] * 100', dependencies: ['lg_cancelled', 'lg_total'],
    description: 'Отменённые заявки от всех заявок периода.' },
  // ── Сроки ──
  { id: 'lg_ship_hist', nameRu: 'Отгружено с историей статусов (служебная)', nameShortRu: null, dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', isHiddenInUi: true, get: r => r.shipWithHist,
    description: 'Отгруженные заявки, у которых в истории есть момент отгрузки.' },
  { id: 'lg_on_time_n', nameRu: 'Отгружено в срок (служебная)', nameShortRu: null, dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', isHiddenInUi: true, get: onTimeN,
    description: 'Отгруженные не позже плановой даты.' },
  { id: 'lg_on_time_pct', nameRu: 'Отгружено в срок', nameShortRu: 'В срок, %', dataType: 'percent', decimalPlaces: 1, aggregationFn: 'avg', get: r => r.onTimePct,
    metricType: 'calculated', formula: '[lg_on_time_n] / [lg_ship_hist] * 100', dependencies: ['lg_on_time_n', 'lg_ship_hist'],
    description: 'Доля заявок, отгруженных не позже плановой даты (дата первой отгрузки по Москве). Считается по отгруженным заявкам, у которых в истории есть момент отгрузки.' },
  { id: 'lg_cycle_days', nameRu: 'Цикл до отгрузки, дн (медиана)', nameShortRu: 'Цикл, дн', dataType: 'decimal', decimalPlaces: 1, aggregationFn: 'none', get: r => r.cycleDaysMed,
    description: 'Медиана дней от появления заявки («Новая заявка») до первой отгрузки.' },
  { id: 'lg_react_hours', nameRu: 'Взятие в работу, ч (медиана)', nameShortRu: 'Реакция, ч', dataType: 'decimal', decimalPlaces: 1, aggregationFn: 'none', get: r => r.reactHoursMed,
    description: 'Медиана часов от «Новая заявка» до «Взята в работу».' },
  { id: 'lg_overdue', nameRu: 'Просрочено сейчас', nameShortRu: 'Просрочено', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', get: r => r.overdue,
    description: 'На сегодня, по всем датам (не только за период): плановая отгрузка прошла, а заявка ещё в работе.' },
  { id: 'lg_overdue30', nameRu: 'Просрочено больше 30 дней', nameShortRu: 'Просрочено > 30 дн', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', get: r => r.overdue30,
    description: 'Из просроченных сейчас — плановая отгрузка прошла больше 30 дней назад.' },
  { id: 'lg_fix_n', nameRu: 'Возвращались на правку (служебная)', nameShortRu: null, dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', isHiddenInUi: true, get: fixN,
    description: 'Отгруженные заявки, которые возвращались в «Отгружено, требует правки логиста».' },
  { id: 'lg_fix_pct', nameRu: 'Возвраты на правку', nameShortRu: 'Правки, %', dataType: 'percent', decimalPlaces: 1, aggregationFn: 'avg', get: r => r.fixPct,
    metricType: 'calculated', formula: '[lg_fix_n] / [lg_shipped] * 100', dependencies: ['lg_fix_n', 'lg_shipped'],
    description: 'Доля отгруженных заявок, которые возвращались в статус «Отгружено, требует правки логиста».' },
  // ── Деньги ──
  { id: 'lg_sales', nameRu: 'Выручка отгруженного', nameShortRu: 'Выручка, ₽', dataType: 'money', decimalPlaces: 0, aggregationFn: 'sum', get: r => r.salesNv,
    description: 'Сумма строк отгруженных заявок, без НДС.' },
  { id: 'lg_avg_check', nameRu: 'Средний чек', nameShortRu: 'Ср. чек, ₽', dataType: 'money', decimalPlaces: 0, aggregationFn: 'avg', get: r => r.avgCheckNv,
    metricType: 'calculated', formula: '[lg_sales] / [lg_shipped]', dependencies: ['lg_sales', 'lg_shipped'],
    description: 'Выручка отгруженного, делённая на число отгруженных заявок, без НДС.' },
  { id: 'lg_no_purchase', nameRu: 'Отгружено без закупки', nameShortRu: 'Без закупки', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', get: r => r.shippedNoPurchase,
    description: 'Отгруженные заявки, к которым не привязано ни одного приобретения — себестоимости нет.' },
  { id: 'lg_margin_base', nameRu: 'Заявок в расчёте маржи', nameShortRu: 'В расчёте маржи', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', get: r => r.marginBaseN,
    description: 'Отгруженные заявки с закупками, кроме заявок с задвоенной суммой закупки.' },
  { id: 'lg_excl_broken', nameRu: 'Исключено: задвоенная закупка', nameShortRu: 'Задвоенная закупка', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', get: r => r.exclBroken,
    description: 'Отгруженные заявки, у которых сумма закупки в 1С задвоена, — они не входят в маржу.' },
  { id: 'lg_m_sales', nameRu: 'Продажа в расчёте маржи (служебная)', nameShortRu: null, dataType: 'money', decimalPlaces: 0, aggregationFn: 'sum', isHiddenInUi: true, get: r => r.mSalesNv,
    description: 'Сумма продажи заявок, входящих в расчёт маржи, без НДС.' },
  { id: 'lg_margin', nameRu: 'Маржа', nameShortRu: 'Маржа, ₽ (предв.)', dataType: 'money', decimalPlaces: 0, aggregationFn: 'sum', get: r => r.marginNv,
    description: `Продажа минус закупка по заявкам в расчёте маржи, без НДС.${PRELIM}` },
  { id: 'lg_margin_pct', nameRu: 'Маржа, %', nameShortRu: 'Маржа, % (предв.)', dataType: 'percent', decimalPlaces: 1, aggregationFn: 'avg', get: r => r.marginPct,
    metricType: 'calculated', formula: '[lg_margin] / [lg_m_sales] * 100', dependencies: ['lg_margin', 'lg_m_sales'],
    description: `Маржа к продаже по заявкам в расчёте маржи, без НДС.${PRELIM}` },
  // ── Доставка ──
  { id: 'lg_d_sale', nameRu: 'Доставка: выручка', nameShortRu: 'Выручка, ₽', dataType: 'money', decimalPlaces: 0, aggregationFn: 'sum', get: r => r.dSale || null,
    description: 'Строки отгруженных заявок с доставкой в названии номенклатуры, без НДС (без заявок с задвоенной закупкой).' },
  { id: 'lg_d_cost', nameRu: 'Доставка: расход', nameShortRu: 'Расход, ₽', dataType: 'money', decimalPlaces: 0, aggregationFn: 'sum', get: r => r.dCost || null,
    description: 'Строки приобретений «Доставка» и «Доставка для логистов», без НДС.' },
  { id: 'lg_d_ratio', nameRu: 'Доставка: расход к выручке', nameShortRu: 'Расход / выручка, %', dataType: 'percent', decimalPlaces: 1, aggregationFn: 'avg', get: r => r.dCostToSalePct,
    metricType: 'calculated', formula: '[lg_d_cost] / [lg_d_sale] * 100', dependencies: ['lg_d_cost', 'lg_d_sale'],
    description: 'Расход на доставку к выручке за доставку. Больше 100 % — доставка в минус.' },
];

const SUMMARY_METRICS: Metric[] = DEFS.map((d, i) => ({
  id: d.id, nameRu: d.nameRu, nameShortRu: d.nameShortRu, description: d.description,
  humanDescription: d.description, formulaHuman: null,
  calcOk: true, fillOk: true,
  metricType: d.metricType ?? 'external', dataType: d.dataType, formula: d.formula ?? null,
  dependencies: d.dependencies ?? [], decimalPlaces: d.decimalPlaces, aggregationFn: d.aggregationFn,
  category: LOGIST_CATEGORY, sortOrder: 6000 + i,
  isCore: false, isActive: true, isHiddenInUi: d.isHiddenInUi ?? false, isTest: false,
  source: 'deals', aggFn: null, aggField: null, dateField: null, filters: [], tags: ['realizations'],
  isCollectOk: true, isCalcOk: true, color: null,
}));
// Группа «Звонки» (задача #8314) — отдельный модуль callMetrics.ts, те же slug'и.
export const LOGIST_METRICS: Metric[] = [...SUMMARY_METRICS, ...CALL_METRICS];
export const LOGIST_METRIC_IDS = LOGIST_METRICS.map(m => m.id);
export const LOGIST_DEFAULT_METRIC_IDS = LOGIST_METRICS.filter(m => !m.isHiddenInUi).map(m => m.id);

/** SummaryRow → значения метрик строки (те же числа, что в buildSummary). */
export function summaryToMetrics(r: SummaryRow): Record<string, number | null> {
  return Object.fromEntries(DEFS.map(d => [d.id, d.get(r)]));
}

/** Группы колонок по умолчанию (находка 11): как «БРОНИ И ПРОДАЖИ» в «Продажах». */
export const LOGIST_COLUMN_GROUPS: { name: string; metricIds: string[] }[] = [
  { name: 'Заявки', metricIds: ['lg_total', 'lg_shipped', 'lg_cancelled', 'lg_in_work', 'lg_cancel_pct'] },
  { name: 'Сроки', metricIds: ['lg_on_time_pct', 'lg_cycle_days', 'lg_react_hours', 'lg_overdue', 'lg_overdue30', 'lg_fix_pct'] },
  { name: 'Деньги, без НДС', metricIds: ['lg_sales', 'lg_avg_check', 'lg_no_purchase', 'lg_margin_base', 'lg_excl_broken', 'lg_margin', 'lg_margin_pct'] },
  { name: 'Доставка', metricIds: ['lg_d_sale', 'lg_d_cost', 'lg_d_ratio'] },
  CALL_COLUMN_GROUP,
];

/**
 * Клик по ячейке сводки → фильтр списка «Заявки» (дрилл = состав числа там, где у
 * метрики есть однозначный статус). Остальные метрики открывают все заявки строки.
 */
export const LOGIST_DRILL_STATUS: Record<string, string> = {
  lg_shipped: 'grp:shipped', lg_cancelled: 'grp:cancelled', lg_in_work: 'grp:in_work',
  lg_sales: 'grp:shipped', lg_avg_check: 'grp:shipped', lg_on_time_pct: 'grp:shipped', lg_cycle_days: 'grp:shipped',
  lg_fix_pct: 'grp:shipped', lg_no_purchase: 'grp:shipped', lg_margin_base: 'grp:shipped', lg_excl_broken: 'grp:shipped',
  lg_margin: 'grp:shipped', lg_margin_pct: 'grp:shipped', lg_d_sale: 'grp:shipped', lg_d_cost: 'grp:shipped', lg_d_ratio: 'grp:shipped',
};

/**
 * Раскраска (градиент) по смыслу метрики (доработка #8126): у долей градиент включён
 * по умолчанию, но шкала «больше = лучше» красила высокую долю отмен в зелёный.
 * Здесь — где больше = хуже (шкала инвертирована), и счётчики-«плохие» метрики, у
 * которых градиент включаем явно (по умолчанию он только у долей).
 */
export const LOGIST_HEATMAP_ON_IDS = ['lg_overdue', 'lg_overdue30', 'lg_no_purchase', 'lg_excl_broken', 'lg_cycle_days', 'lg_react_hours', 'lc_missed_in'];
export const LOGIST_HEATMAP_INVERTED_IDS = ['lg_cancel_pct', 'lg_fix_pct', 'lg_d_ratio', 'lc_short_pct', ...LOGIST_HEATMAP_ON_IDS];
