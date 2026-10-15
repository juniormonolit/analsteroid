import type { Metric } from '../metrics/types';

// Отчёт «Ответы на запросы» — по методике Панели снабжения (решение владельца 14.10:
// замена прежнего отчёта по менеджерам-постановщикам). Строка = аккаунт снабженца
// (исполнитель, давший ответ), срез «Категории» — проект снабжения. Расчёт —
// lib/supplyPanel (порт calc.py/metrics.py панели, сверка с Python — npm run
// verify:supply-panel), данные — снимок, который джоба supplyPanelSync тянет с
// сервера панели раз в 15 минут. Методика — Методика.md панели, сверка с прежним
// отчётом — ai_docs/fresh_docs/SUPPLY_PANEL_RESPONSES_GAP.md.
//
// Метрики объявлены КОДОМ (catalog.ts дописывает их к каталогу), видны только в
// разделе «Реализация». id метрики = 'sp_' + ключ строки агрегата панели.
export const RESPONSE_SLUG = 'requests-response';
/** Срез «Категории»: строка = проект снабжения (группа Bitrix24). */
export const RESPONSE_CATEGORIES_SLUG = 'requests-response-categories';
export const RESPONSE_SLUGS = [RESPONSE_SLUG, RESPONSE_CATEGORIES_SLUG];
export const RESPONSE_CATEGORY = 'Ответы на запросы';
export const SP_PREFIX = 'sp_';

type Def = Pick<Metric, 'nameRu' | 'nameShortRu' | 'dataType' | 'decimalPlaces' | 'aggregationFn' | 'description'>
  & Partial<Pick<Metric, 'isHiddenInUi'>> & { key: string };

const H = 'рабочие часы: будни 09:00–18:00 МСК, праздники 2026 исключены';
const D = (key: string, nameRu: string, nameShortRu: string, dataType: Def['dataType'], decimalPlaces: number, description: string, isHiddenInUi = false): Def => ({
  key, nameRu, nameShortRu, dataType, decimalPlaces, description, isHiddenInUi,
  // Итого и подытоги регионов/департаментов приходят из расчёта панели (не суммой
  // строк): сделка у нескольких снабженцев в итоге одна, средние — по событиям.
  aggregationFn: dataType === 'int' || dataType === 'money' ? 'sum' : 'none',
});

const DEFS: Def[] = [
  // Запросы
  D('new', 'Новые запросы', 'Новые', 'int', 0, 'Задачи в проектах снабжения, созданные в периоде. Засчитываются исполнителю задачи — автору первого ответа (ответа нет — текущему исполнителю). Тестовые и удалённые исключены.'),
  D('new_per_day', 'Новые запросы в рабочий день (нагрузка)', 'Новые / день', 'decimal', 1, 'Новые запросы / рабочих дней периода. KPI «Нагрузка».'),
  D('reopens', 'Возобновлённые запросы', 'Возобн.', 'int', 0, 'Возобновления (начало цикла 2+) в периоде: «Сделаны»/«Завершены» → обратно в работу. Одна задача может дать несколько. Засчитываются тому, кто потом ответил.'),
  D('reopens_per_day', 'Возобновлённые в рабочий день', 'Возобн. / день', 'decimal', 1, 'Возобновлённые / рабочих дней периода.'),
  D('req_all', 'Все запросы', 'Все', 'int', 0, 'Новые + возобновлённые.'),
  D('req_all_per_day', 'Все запросы в рабочий день', 'Все / день', 'decimal', 1, 'Все запросы / рабочих дней периода.'),
  // Ответы
  D('done', 'Ответы по новым', 'Ответы (новые)', 'int', 0, 'Задачи, первый ответ (переход в «Сделаны», или сразу в «Завершены») по которым дан в периоде.'),
  D('repeat', 'Ответы по возобновлённым', 'Ответы (повт.)', 'int', 0, 'Ответы циклов 2+ (после возобновления) в периоде.'),
  D('answers', 'Ответы все', 'Ответы', 'int', 0, 'Все переходы в «Сделаны» в периоде: первые и повторные. Ответ засчитывается исполнителю в момент перехода.'),
  D('answers_per_day', 'Ответы в рабочий день', 'Ответы / день', 'decimal', 1, 'Все ответы / рабочих дней периода.'),
  // Скорость
  D('all_answer_h', 'Скорость ответа общая, ч', 'Ответ общий, ч', 'decimal', 2, `Главный показатель (KPI). Среднее по всем ответам периода: первые (создание → «Сделаны») и повторные (возобновление → «Сделаны»); ${H}.`),
  D('answer_h', 'Скорость первого ответа, ч', '1-й ответ, ч', 'decimal', 2, `Среднее, цикл 1: создание → «Сделаны», по ответам периода; ${H}.`),
  D('answer_med_h', 'Скорость первого ответа, медиана, ч', '1-й ответ, мед., ч', 'decimal', 2, `Медиана того же, что «Скорость первого ответа»; ${H}.`),
  D('repeat_answer_h', 'Скорость повторного ответа, ч', 'Повт. ответ, ч', 'decimal', 2, `Среднее: возобновление → «Сделаны», циклы 2+; ${H}.`),
  D('take_h', 'Скорость взятия в работу, ч', 'Взятие, ч', 'decimal', 2, `Среднее, цикл 1: создание → «Выполняются»; ответы без взятия в работу исключены; ${H}.`),
  D('exec_h', 'Скорость выполнения, ч', 'Выполнение, ч', 'decimal', 2, `Среднее, цикл 1: «Выполняются» → «Сделаны»; ${H}. В панели снабжения на странице не показывается.`, true),
  D('cycle_h', 'Скорость цикла до «Завершены», ч', 'Цикл, ч', 'decimal', 2, `Среднее, цикл 1: создание → приёмка («Завершены»); ${H}.`),
  // Качество
  D('gt3', 'Ответов дольше 3 ч', '> 3 ч, шт.', 'int', 0, 'Первые ответы периода дольше 3 рабочих часов.'),
  D('gt3_pct', 'Доля ответов дольше 3 ч', '> 3 ч, %', 'percent', 1, 'Первые ответы дольше 3 рабочих часов / ответы по новым.'),
  D('gt9', 'Ответов дольше 9 ч', '> 9 ч, шт.', 'int', 0, 'Первые ответы периода дольше 9 рабочих часов.'),
  D('gt9_pct', 'Доля ответов дольше 9 ч', '> 9 ч, %', 'percent', 1, 'Первые ответы дольше 9 рабочих часов / ответы по новым. KPI (депремирование).'),
  D('reopened', 'Возобновлено потом', 'Возобн. потом', 'int', 0, 'Из ответов по новым — сколько задач потом возобновили.'),
  D('reopened_pct', 'Доля возобновлённых потом', 'Возобн. потом, %', 'percent', 1, 'Возобновлено потом / ответы по новым.'),
  D('skip_take', 'Ответов без взятия в работу', 'Без взятия', 'int', 0, 'Первые ответы мимо статуса «Выполняются» — нарушение порядка работы.'),
  D('skip_take_pct', 'Доля ответов без взятия в работу', 'Без взятия, %', 'percent', 1, 'Ответы без взятия в работу / ответы по новым.'),
  // Продажи
  D('sales', 'Продажи по запросам', 'Продажи', 'int', 0, 'Сделки, связанные с запросами исполнителя, проданные в периоде без последующего проигрыша. Срок после запроса не ограничен; сделка у нескольких исполнителей учитывается у каждого, в итоге — один раз.'),
  D('amount', 'Сумма продаж по запросам', 'Продажи, ₽', 'money', 0, 'Сумма проданных сделок целиком, каждая сделка один раз.'),
  D('conversion_pct', 'Конверсия из запросов в продажу', 'Конверсия, %', 'percent', 1, 'Задачи, связанные с проданными в периоде сделками / новые запросы периода. KPI.'),
  D('cr_sale_pct', 'CR продажи', 'CR продажи, %', 'percent', 1, 'Проданные в периоде сделки / (проданные + проигранные в периоде), только сделки с запросами.'),
  // Отгрузки
  D('shipments', 'Отгрузки по запросам', 'Отгрузки', 'int', 0, 'Сделки с запросами, переведённые в «отгружено» в периоде без последующего проигрыша.'),
  D('ship_amount', 'Сумма отгрузок по запросам', 'Отгрузки, ₽', 'money', 0, 'Сумма отгруженных сделок целиком, каждая сделка один раз.'),
  D('ship_conversion_pct', 'Конверсия из запросов в отгрузку', 'Конв. в отгр., %', 'percent', 1, 'Задачи, связанные с отгруженными в периоде сделками / новые запросы периода.'),
  D('cr_ship_pct', 'CR отгрузки', 'CR отгрузки, %', 'percent', 1, 'Отгруженные в периоде сделки / (отгруженные + проигранные в периоде).'),
];

export const RESPONSE_METRICS: Metric[] = DEFS.map((d, i) => ({
  id: SP_PREFIX + d.key, nameRu: d.nameRu, nameShortRu: d.nameShortRu, description: d.description,
  humanDescription: d.description, formulaHuman: null,
  calcOk: true, fillOk: true,
  metricType: 'external', dataType: d.dataType, formula: null,
  dependencies: [], decimalPlaces: d.decimalPlaces, aggregationFn: d.aggregationFn,
  category: RESPONSE_CATEGORY, sortOrder: 5000 + i,
  isCore: false, isActive: true, isHiddenInUi: d.isHiddenInUi ?? false, isTest: false,
  source: 'deals', aggFn: null, aggField: null, dateField: null, filters: [], tags: ['realizations'],
  isCollectOk: true, isCalcOk: true, color: null,
}));

export const RESPONSE_METRIC_IDS = RESPONSE_METRICS.map(m => m.id);
/** Ключ панели (строка агрегата, PICK для списка задач) по id метрики. */
export const spKey = (metricId: string): string | null => metricId.startsWith(SP_PREFIX) ? metricId.slice(SP_PREFIX.length) : null;
/** Ключ списка задач панели (PICK) по id метрики: у долей без своего PICK — список числителя. */
export function spPickKey(metricId: string): string | null {
  const k = spKey(metricId);
  return k === 'reopened_pct' ? 'reopened' : k === 'skip_take_pct' ? 'skip_take' : k;
}

/** Группы колонок по умолчанию — блоки страницы панели. */
export const RESPONSE_COLUMN_GROUPS: { name: string; metricIds: string[] }[] = [
  { name: 'Запросы', metricIds: ['new', 'new_per_day', 'reopens', 'req_all'] },
  { name: 'Ответы', metricIds: ['done', 'repeat', 'answers', 'answers_per_day'] },
  { name: 'Скорость', metricIds: ['all_answer_h', 'answer_h', 'answer_med_h', 'repeat_answer_h', 'take_h', 'cycle_h'] },
  { name: 'Качество', metricIds: ['gt3_pct', 'gt9_pct', 'reopened_pct', 'skip_take_pct'] },
  { name: 'Продажи', metricIds: ['sales', 'amount', 'conversion_pct', 'cr_sale_pct'] },
  { name: 'Отгрузки', metricIds: ['shipments', 'ship_amount', 'ship_conversion_pct', 'cr_ship_pct'] },
].map(g => ({ name: g.name, metricIds: g.metricIds.map(k => SP_PREFIX + k) }));
export const RESPONSE_DEFAULT_METRIC_IDS = RESPONSE_COLUMN_GROUPS.flatMap(g => g.metricIds);
