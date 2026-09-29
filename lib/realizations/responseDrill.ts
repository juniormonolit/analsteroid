// Дрилл «Ответов на запросы» по ячейке (задача #8126, аудит Полины, находка 2):
// список = ровно то население, из которого сложилось число в ячейке. Условия —
// те же, что в агрегате fetchRequestResponse (features/reports/engine/requestResponse.ts),
// один в один; формулы метрик не меняются. Алиасы: rq — задачи-запросы периода
// (requestTasksCte), d — sa.deals (left join по deal_id).
//
// Метрики-медианы и доли показывают базу, по которой считались (запросы, взятые в
// работу / закрытые / с ответом), доли «< 3 ч / < 9 ч» — числитель (быстрые ответы),
// а в шапке дрилла — «из N с ответом». Сделочные метрики — по одной строке на сделку
// (в ячейке сделки считаются distinct).

export interface ResponseDrillRule {
  /** SQL-условие поверх rq/d; пусто — все запросы периода. */
  where: string;
  /** Одна строка на сделку (distinct deal_id), а не на задачу. */
  perDeal?: boolean;
  /** Как назвать строки списка в итоге: «запросов» / «сделок». */
  unit: 'requests' | 'deals';
  /** Пояснение, если число строк по смыслу ≠ значению ячейки (медианы, доли). */
  note?: string;
}

const ANSWERED = 'rq.first_answer_at is not null';

export const RESPONSE_DRILL_RULES: Record<string, ResponseDrillRule> = {
  rr_requests_total: { where: '', unit: 'requests' },
  rr_requests_new: { where: 'rq.status in (1, 2)', unit: 'requests' },
  rr_requests_in_work: { where: 'rq.status in (3, 6)', unit: 'requests' },
  rr_requests_closed: { where: '(rq.status in (4, 5) or rq.closed_at is not null)', unit: 'requests' },
  rr_time_to_work_med_h: { where: 'rq.date_start is not null', unit: 'requests', note: 'Медиана считается по этим запросам — взятым в работу' },
  rr_cycle_med_h: { where: 'rq.closed_at is not null', unit: 'requests', note: 'Медиана считается по этим запросам — закрытым' },
  rr_closed_no_take: { where: 'rq.closed_at is not null and rq.date_start is null', unit: 'requests' },
  rr_answered: { where: ANSWERED, unit: 'requests' },
  rr_first_answer_med_h: { where: ANSWERED, unit: 'requests', note: 'Медиана считается по этим запросам — с ответом' },
  rr_answer_lt3_cnt: { where: "rq.first_answer_at - rq.created_at < interval '3 hours'", unit: 'requests' },
  rr_answer_lt9_cnt: { where: "rq.first_answer_at - rq.created_at < interval '9 hours'", unit: 'requests' },
  rr_answer_lt3_pct: { where: "rq.first_answer_at - rq.created_at < interval '3 hours'", unit: 'requests', note: 'Показаны ответы быстрее 3 ч — числитель доли' },
  rr_answer_lt9_pct: { where: "rq.first_answer_at - rq.created_at < interval '9 hours'", unit: 'requests', note: 'Показаны ответы быстрее 9 ч — числитель доли' },
  rr_deals: { where: 'd.deal_id is not null', perDeal: true, unit: 'deals' },
  rr_sold_deals: { where: 'd.sold_at is not null', perDeal: true, unit: 'deals' },
  rr_sold_amount: { where: 'd.sold_at is not null', perDeal: true, unit: 'deals', note: 'Сумма — по этим проданным сделкам' },
  rr_delivered_deals: { where: 'd.delivered_at is not null', perDeal: true, unit: 'deals' },
  rr_delivered_amount: { where: 'd.delivered_at is not null', perDeal: true, unit: 'deals', note: 'Сумма — по этим отгруженным сделкам' },
};

/** Правило для metricId; неизвестная/пустая метрика — все запросы (клик по имени строки). */
export function responseDrillRule(metricId: string | null | undefined): ResponseDrillRule {
  return (metricId && RESPONSE_DRILL_RULES[metricId]) || RESPONSE_DRILL_RULES.rr_requests_total;
}

/** Параметр metricId из query: только известные id (в SQL идёт условие из словаря, не ввод). */
export function parseDrillMetric(raw: string | null): string | null {
  return raw && Object.prototype.hasOwnProperty.call(RESPONSE_DRILL_RULES, raw) ? raw : null;
}
