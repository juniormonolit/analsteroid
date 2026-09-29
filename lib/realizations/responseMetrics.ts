import type { Metric } from '../metrics/types';

// Отчёт «Ответы на запросы» (задача #8034, CONTEXT_UPDATE Сергея 29.09) — на общем
// движке отчётов: slug 'requests-response' в /api/reports/run, строки = менеджеры
// (постановщик задачи), таблица/сравнение/экспорт — SalesReportPage + ReportTable.
//
// Метрики объявлены КОДОМ, а не строками таблицы metrics (YC analytics): catalog.ts
// дописывает их к каталогу, если в БД таких id нет. Так отчёт не зависит от ручного
// прогона миграции на проде, а вне раздела их не видно: /api/catalog/metrics
// отдаёт их только тем, кому открыта «Реализация» (canViewRealizations).
//
// «Запрос» = задача Битрикса в потоке снабжения (sa.bitrix_task_current +
// sa.bitrix_flows), без потоков «Поддержка», «Акты сверок», «Коррекция заявок».
// Методика и цифры для сверки — owners-inbox/bitrix-requests-response-speed-data-check-20260929.md.
export const RESPONSE_SLUG = 'requests-response';
export const RESPONSE_CATEGORY = 'Ответы на запросы';
export const RESPONSE_EXCLUDED_FLOWS = ['Поддержка', 'Акты сверок', 'Коррекция заявок'];
/** С этой даты results[] есть у ~92% задач — раньше скорость ответа неполна. */
export const RESPONSE_RELIABLE_FROM = '2026-09-07';

type Def = Pick<Metric, 'id' | 'nameRu' | 'nameShortRu' | 'dataType' | 'decimalPlaces' | 'aggregationFn' | 'description'>
  & Partial<Pick<Metric, 'metricType' | 'formula' | 'dependencies' | 'isHiddenInUi'>>;

const DEFS: Def[] = [
  { id: 'rr_requests_total', nameRu: 'Запросы: всего', nameShortRu: 'Запросов', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum',
    description: 'Задачи в потоках снабжения, поставленные менеджером (постановщик = created_by) в периоде (created_at, МСК). Без потоков «Поддержка», «Акты сверок», «Коррекция заявок», без удалённых.' },
  { id: 'rr_requests_new', nameRu: 'Запросы: новые (не взяты)', nameShortRu: 'Новые', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum',
    description: 'Из запросов периода — сейчас в статусе «Новая» / «Ждёт выполнения» (status 1, 2).' },
  { id: 'rr_requests_in_work', nameRu: 'Запросы: в работе', nameShortRu: 'В работе', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum',
    description: 'Из запросов периода — сейчас «Выполняется» или «Отложена» (status 3, 6).' },
  { id: 'rr_requests_closed', nameRu: 'Запросы: завершены', nameShortRu: 'Завершено', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum',
    description: 'Из запросов периода — «Ждёт контроля» или «Завершена» (status 4, 5), либо есть closed_at.' },
  { id: 'rr_time_to_work_med_h', nameRu: 'Время до работы, ч (медиана)', nameShortRu: 'До работы, ч', dataType: 'decimal', decimalPlaces: 1, aggregationFn: 'none',
    description: 'Медиана date_start − created_at, часы, по запросам, взятым в работу (date_start заполнен).' },
  { id: 'rr_cycle_med_h', nameRu: 'Цикл до «завершено», ч (медиана)', nameShortRu: 'Цикл, ч', dataType: 'decimal', decimalPlaces: 1, aggregationFn: 'none',
    description: 'Медиана closed_at − created_at, часы, по закрытым запросам.' },
  { id: 'rr_closed_no_take', nameRu: 'Закрыто без взятия в работу', nameShortRu: 'Без взятия', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum',
    description: 'Запросы с closed_at и пустым date_start — закрыты, не побывав «в работе».' },
  { id: 'rr_answered', nameRu: 'Запросы с ответом (результатом)', nameShortRu: 'С ответом', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum',
    description: `Запросы, у которых есть хотя бы один результат задачи (results[]). Надёжно с ${'07.09.2026'}: раньше результат есть только у ~45–55% задач.` },
  { id: 'rr_first_answer_med_h', nameRu: 'Первый ответ, ч (медиана)', nameShortRu: '1-й ответ, ч', dataType: 'decimal', decimalPlaces: 1, aggregationFn: 'none',
    description: 'Медиана min(results.createdAt) − created_at, часы, по запросам с ответом. Надёжно с 07.09.2026.' },
  { id: 'rr_answer_lt3_cnt', nameRu: 'Ответ быстрее 3 ч (служебная)', nameShortRu: null, dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', isHiddenInUi: true,
    description: 'Запросы, первый ответ по которым пришёл быстрее 3 ч.' },
  { id: 'rr_answer_lt9_cnt', nameRu: 'Ответ быстрее 9 ч (служебная)', nameShortRu: null, dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', isHiddenInUi: true,
    description: 'Запросы, первый ответ по которым пришёл быстрее 9 ч.' },
  { id: 'rr_answer_lt3_pct', nameRu: 'Доля ответов быстрее 3 ч', nameShortRu: '< 3 ч, %', dataType: 'percent', decimalPlaces: 1, aggregationFn: 'avg',
    metricType: 'calculated', formula: '[rr_answer_lt3_cnt] / [rr_answered] * 100', dependencies: ['rr_answer_lt3_cnt', 'rr_answered'],
    description: 'Доля запросов с первым ответом быстрее 3 ч (норматив потока) от запросов с ответом. Надёжно с 07.09.2026.' },
  { id: 'rr_answer_lt9_pct', nameRu: 'Доля ответов быстрее 9 ч', nameShortRu: '< 9 ч, %', dataType: 'percent', decimalPlaces: 1, aggregationFn: 'avg',
    metricType: 'calculated', formula: '[rr_answer_lt9_cnt] / [rr_answered] * 100', dependencies: ['rr_answer_lt9_cnt', 'rr_answered'],
    description: 'Доля запросов с первым ответом быстрее 9 ч от запросов с ответом. Надёжно с 07.09.2026.' },
  { id: 'rr_deals', nameRu: 'Сделок по запросам', nameShortRu: 'Сделок', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum',
    description: 'Разные сделки (deal_id задачи → sa.deals), по которым были запросы периода.' },
  { id: 'rr_sold_deals', nameRu: 'Продано сделок по запросам', nameShortRu: 'Продано', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum',
    description: 'Сделки запросов периода с заполненной датой продажи (sa.deals.sold_at, на сегодня).' },
  { id: 'rr_sold_amount', nameRu: 'Сумма продаж по запросам', nameShortRu: 'Продано, ₽', dataType: 'money', decimalPlaces: 0, aggregationFn: 'sum',
    description: 'Σ sa.deals.amount по проданным сделкам запросов периода (каждая сделка один раз).' },
  { id: 'rr_delivered_deals', nameRu: 'Отгружено сделок по запросам', nameShortRu: 'Отгружено', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum',
    description: 'Сделки запросов периода с датой отгрузки (sa.deals.delivered_at, на сегодня).' },
  { id: 'rr_delivered_amount', nameRu: 'Сумма отгрузок по запросам', nameShortRu: 'Отгружено, ₽', dataType: 'money', decimalPlaces: 0, aggregationFn: 'sum',
    description: 'Σ sa.deals.amount по отгруженным сделкам запросов периода (каждая сделка один раз).' },
];

export const RESPONSE_METRICS: Metric[] = DEFS.map((d, i) => ({
  id: d.id, nameRu: d.nameRu, nameShortRu: d.nameShortRu, description: d.description,
  humanDescription: d.description, formulaHuman: null,
  calcOk: true, fillOk: true,
  metricType: d.metricType ?? 'external', dataType: d.dataType, formula: d.formula ?? null,
  dependencies: d.dependencies ?? [], decimalPlaces: d.decimalPlaces, aggregationFn: d.aggregationFn,
  category: RESPONSE_CATEGORY, sortOrder: 5000 + i,
  isCore: false, isActive: true, isHiddenInUi: d.isHiddenInUi ?? false, isTest: false,
  source: 'deals', aggFn: null, aggField: null, dateField: null, filters: [], tags: ['realizations'],
  isCollectOk: true, isCalcOk: true, color: null,
}));

export const RESPONSE_METRIC_IDS = RESPONSE_METRICS.map(m => m.id);
/** Колонки отчёта по умолчанию (служебные счётчики тянутся зависимостями). */
export const RESPONSE_DEFAULT_METRIC_IDS = RESPONSE_METRICS.filter(m => !m.isHiddenInUi).map(m => m.id);

/** Метрики-медианы: «Итого» — медиана по всей совокупности, не сумма строк. */
export const RESPONSE_MEDIAN_IDS = ['rr_time_to_work_med_h', 'rr_cycle_med_h', 'rr_first_answer_med_h'];

/** Группы колонок по умолчанию (задача #8126, находка 21): как «БРОНИ И ПРОДАЖИ» в «Продажах». */
export const RESPONSE_COLUMN_GROUPS: { name: string; metricIds: string[] }[] = [
  { name: 'Запросы', metricIds: ['rr_requests_total', 'rr_requests_new', 'rr_requests_in_work', 'rr_requests_closed', 'rr_closed_no_take'] },
  { name: 'Скорость', metricIds: ['rr_time_to_work_med_h', 'rr_cycle_med_h', 'rr_answered', 'rr_first_answer_med_h', 'rr_answer_lt3_pct', 'rr_answer_lt9_pct'] },
  { name: 'Сделки', metricIds: ['rr_deals', 'rr_sold_deals', 'rr_sold_amount', 'rr_delivered_deals', 'rr_delivered_amount'] },
];
