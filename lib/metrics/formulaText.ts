import type { Metric } from './types';

// Строка «формула расчёта» для «?» у метрики (правка владельца 17.08, дополнение
// 24.08) — БЕЗ серверных импортов: используется в клиентских попапах
// (MetricPanel, шапка колонки ReportTable).
//
// Приоритет: ручная formula_human из каталога (миграция 185 — «что в числителе,
// что в знаменателе» словами) → для calculated автогенерация из русских имён
// (каталог кладёт её в тот же formulaHuman) → для collected человеческая сборка
// из определения через словари ниже. external без ручной формулы — null: движок
// в коде, честной формулы-строки не существует.

const AGG_RU: Record<string, string> = {
  'count_distinct:deal_id': 'число сделок (каждая — один раз)',
  'count_distinct:contact_id': 'число разных заказчиков',
  'sum:amount': 'сумма сделок, ₽',
};
const DATE_RU: Record<string, string> = {
  created_at: 'дата создания', sold_at: 'дата продажи', delivered_at: 'дата отгрузки',
  reserved_at: 'дата брони', confirmed_at: 'дата подтверждения брони', lost_at: 'дата отказа',
};
// Человеческие подписи типовых фильтров конструктора. Ключ — field или field:value.
const FILTER_RU: Record<string, string> = {
  'funnel_type:primary': 'воронка — первичные',
  'funnel_type:repeat': 'воронка — повторные продажи',
  'funnel_type:b2b': 'воронка — юрлица (Б2Б)',
  'funnel_type:b2c': 'воронка — физлица (Б2С)',
  _has_call: 'по сделке есть хотя бы один звонок',
  _lost_within_1h: 'отказ в течение часа после создания',
  _ppp: 'вторая продажа заказчика за всю историю',
  _ppo: 'вторая отгрузка заказчика за всю историю',
  _ppb: 'вторая бронь заказчика за всю историю',
  _pppb: 'вторая подтверждённая бронь заказчика',
  _primary_hist: 'первая продажа заказчика по истории',
  _repeat_hist: 'повторная продажа заказчика по истории',
  _primary_deliv_hist: 'первая отгрузка заказчика по истории',
  _repeat_deliv_hist: 'повторная отгрузка заказчика по истории',
  _complex_client: 'заказчик покупал 2+ разные товарные группы',
  _has_goods: 'в сделке есть товарная (несервисная) позиция',
  'stage_type:new': 'сделка сейчас в стадии «Новая/Необработанная»',
  'head_group_name:—is_null': 'главная товарная группа не заполнена',
};
// Человеческие имена не-датовых полей сделок для generic-веток ниже.
const FIELD_RU: Record<string, string> = { amount: 'сумма сделки' };

function filterRu(field: string, op: string, value: unknown): string {
  const byPair = FILTER_RU[`${field}:${value}`];
  if (byPair) return byPair;
  const byField = FILTER_RU[field];
  if (byField) return byField;
  if (field === 'products' && op === 'is_null') return 'в сделке нет товаров';
  if (field === 'products' && op === 'is_not_null') return 'в сделке есть товары';
  if (field === 'head_group_name' && op === 'is_null') return 'главная товарная группа не заполнена';
  if (op === 'gt_field') return `${DATE_RU[field] ?? field} позже, чем ${DATE_RU[String(value)] ?? value}`;
  // «прямой переход в отказ»: поздняя стадия либо не наступала, либо уже после отказа
  if (op === 'gt_field_or_null') return `${DATE_RU[field] ?? field} не наступала или была позже, чем ${DATE_RU[String(value)] ?? value}`;
  if (op === 'is_null') return `${DATE_RU[field] ? `${DATE_RU[field]} отсутствует` : `${field} пусто`}`;
  if (op === 'is_not_null') return `${DATE_RU[field] ? `есть ${DATE_RU[field]}` : `${field} заполнено`}`;
  const v = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  return `${FIELD_RU[field] ?? DATE_RU[field] ?? field} ${op === 'neq' || op === 'not_in' ? '≠' : '='} ${v}`;
}

// Общие куски человеческой сборки collected-метрики — их делят строка «формула»
// (metricFormulaLine) и чипы выборки «Разбора метрики» (collectedSelectionChips),
// чтобы «?» и полноэкранный разбор не разошлись в словах.
function aggRu(m: Metric): string {
  return AGG_RU[`${m.aggFn ?? ''}:${m.aggField ?? ''}`]
    ?? `${m.aggFn === 'sum' ? 'сумма' : m.aggFn === 'avg' ? 'среднее' : 'количество'} по полю ${m.aggField ?? 'deal_id'}`;
}
// «дата продажи попадает в период»; null — метрика без датового окна.
function dateWindowRu(m: Metric): string | null {
  return m.dateField ? `${DATE_RU[m.dateField] ?? m.dateField} попадает в период` : null;
}

export function metricFormulaLine(m: Metric): string | null {
  // Ручная формула каталога — для любого типа метрики (external в том числе);
  // для calculated без ручной каталог уже положил сюда автогенерацию из имён.
  if (m.formulaHuman) return m.formulaHuman;
  if (m.metricType === 'calculated') return m.formula ?? null;
  if (m.metricType === 'collected') {
    const agg = aggRu(m);
    const dateWin = dateWindowRu(m);
    const win = dateWin ? `, у которых ${dateWin}` : '';
    const filters = (m.filters ?? []).map(f => filterRu(f.field, f.op, f.value)).join('; ');
    return `= ${agg}${win}${filters ? `; условия: ${filters}` : ''}`;
  }
  return null;
}

/**
 * Чипы параметров выборки collected-метрики для «Разбора метрики» (задача
 * владельца 03.09): [агрегат, датовое окно (если есть), ...по одному на фильтр].
 * Те же словари, что у metricFormulaLine, — только не одной строкой, а по частям,
 * чтобы UI мог показать каждый параметр отдельной плашкой. Для calculated/external
 * пустой массив: у них нет выборки сделок, они считаются из других метрик/движка.
 */
export function collectedSelectionChips(m: Metric): string[] {
  if (m.metricType !== 'collected') return [];
  const chips = [aggRu(m)];
  const dateWin = dateWindowRu(m);
  if (dateWin) chips.push(dateWin);
  for (const f of m.filters ?? []) chips.push(filterRu(f.field, f.op, f.value));
  return chips;
}

/**
 * Что за число у метрики — счётчик сделок/заказчиков, сумма в рублях или иное
 * (доля, среднее, месяцы). «Разбор» по этому выбирает, как показывать живую
 * выборку: перечнем с количеством или с суммой. Для collected смотрим на сам
 * агрегат (он первичен: dataType у collected — только формат вывода), для
 * calculated/external — на dataType, другого источника нет.
 */
export function metricValueKind(m: Metric): 'count' | 'amount' | 'other' {
  if (m.metricType === 'collected') {
    if (m.aggFn === 'count_distinct' || m.aggFn === 'count_all') return 'count';
    if ((m.aggFn === 'sum' || m.aggFn === 'avg') && m.aggField === 'amount') return 'amount';
    return 'other';
  }
  if (m.dataType === 'money') return 'amount';
  if (m.dataType === 'int') return 'count';
  return 'other';
}
