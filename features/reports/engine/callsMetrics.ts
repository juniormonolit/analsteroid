import { analyticsDb } from '@/lib/db/clients';
import { toSqlInterval, periodDateStrFromInstant, type DateRange } from '@/lib/period';
import { subDays, startOfDay, addDays } from 'date-fns';

// КОЛСТАТ — метрики каталога категории «Звонки» (va.calls, та же MLT-БД, что
// sa.deals/sa.funnels), задача от 10.07 (owners-inbox). Разрез — МЕНЕДЖЕРЫ.
// Инжектится сервером ТОЛЬКО в отчёт «по менеджерам» (см. app/api/reports/run/route.ts),
// тот же приём, что managerActivity.ts/stageConversions.ts: for by-product-groups/
// by-sources ключи просто отсутствуют → computeCalculated по цепочке зависимостей
// отдаёт null.
//
// Данные va.calls — с 30.03.2026 (MIN(called_at), проверено живым запросом 10.07,
// ~197k звонков на 09.07.2026). Если период целиком раньше — честный null (не 0),
// тот же принцип, что DEAL_EVENTS_DATA_START в managerActivity.ts.
export const CALLS_DATA_START = '2026-03-30';

// «Тишина» (метрика 11): дефолт окна — 7 дней без единого звонка. Значение
// зафиксировано в коде (не настраиваемо через UI на MVP) — как и просил владелец
// («7 — дефолт»); при необходимости менять в одном месте.
export const SILENCE_WINDOW_DAYS = 7;

// «Итого» для медианных метрик (задача 10.07, п.7): ключ-сентинел, под которым в
// возвращаемой Map лежит НАСТОЯЩАЯ медиана по ВСЕЙ совокупности (не сумма и не
// медиана медиан) — см. assignGrandBucket ниже. Не валидный manager_id (va.calls/
// deals используют числовой bitrix_user_id) — коллизий с реальными менеджерами нет.
export const GRAND_TOTAL_KEY = '__grand_total__';

// ── Троица (перв.)/(повт.)/(все) ─────────────────────────────────────────────
// «Перв.»/«Повт.» — по funnels.is_repeat СВЯЗАННОЙ СДЕЛКИ звонка (не по адресату
// звонка). «Все» — сумма/медиана/среднее по ВСЕМ звонкам, включая «сироты» (звонок,
// чей deal_id не находится в sa.deals — LEFT JOIN даёт is_repeat IS NULL). Для
// звонковых метрик (1-5, 9) сироты технически возможны (сейчас 0%, см. WORKLOG) —
// код считает их по-настоящему, не хардкодит 0. Для сделочных метрик (6-8, 10, 11)
// «сирот» не бывает — у сделки funnel_id всегда резолвится (INNER JOIN funnels).
export interface Bucket { primary: number; repeat: number; all: number }

function emptyBucket(): Bucket {
  return { primary: 0, repeat: 0, all: 0 };
}

// Строки из GROUPING SETS ((manager_id, is_repeat), (manager_id)) — общий разбор:
// is_all=1 → строка «rollup» (все звонки/сделки менеджера, вне зависимости от
// is_repeat) = искомое значение (все). is_all=0 И is_repeat=false/true → перв./повт.
// is_all=0 И is_repeat IS NULL → «сирота» (не показывается отдельно, уже включён
// в (все) через rollup-строку).
interface GroupingRow {
  manager_id: string | null;
  is_repeat: boolean | null;
  is_all: number;
}

function assignBucket<T extends GroupingRow>(
  map: Map<string, Bucket>,
  row: T,
  valueOf: (r: T) => number,
) {
  if (row.manager_id === null) return; // строка «общего итога» — не сюда, см. assignGrandBucket
  let b = map.get(row.manager_id);
  if (!b) { b = emptyBucket(); map.set(row.manager_id, b); }
  const v = valueOf(row);
  if (row.is_all === 1) b.all = v;
  else if (row.is_repeat === false) b.primary = v;
  else if (row.is_repeat === true) b.repeat = v;
  // is_repeat === null && is_all === 0 → «сирота» — не показываем отдельной веткой,
  // уже учтена в rollup-строке (b.all) сверху.
}

// «Общий итог» (задача 10.07, п.7 — «Итого» для медианных метрик): строки, где
// manager_id ГРУППИРОВКОЙ убран (GROUPING SETS-уровни (is_repeat) и () — см.
// GRAND_TOTAL_GROUPING_SETS_SQL ниже) — медиана/итог по ВСЕЙ совокупности звонков/
// сделок, попавших в фильтр $3 (managerIds, если передан — тот же список менеджеров,
// что уже прошёл фильтры отчёта отдел/тип аккаунтов, см. вызов из route.ts), а НЕ
// сумма и НЕ медиана медиан по менеджерам. Тот же общий агрегатный запрос — ноль
// дополнительных проходов по va.calls/deals.
interface GrandRow extends GroupingRow { is_grand: number }

function assignGrandBucket<T extends GrandRow>(bucket: Bucket, row: T, valueOf: (r: T) => number) {
  if (row.manager_id !== null || row.is_grand !== 1) return;
  const v = valueOf(row);
  if (row.is_all === 1) bucket.all = v;
  else if (row.is_repeat === false) bucket.primary = v;
  else if (row.is_repeat === true) bucket.repeat = v;
}

/** SQL-фрагмент фильтра по менеджерам (department/accountType скоуп отчёта) —
 *  общий для обеих функций ниже. undefined/пустой массив → без фильтра. */
function managerScopeSql(managerIds: string[] | undefined, column: string, paramIndex: number): string {
  if (!managerIds || managerIds.length === 0) return '';
  return `AND ${column}::text = ANY($${paramIndex})`;
}

// ── Метрики 1-5, 9: разрез по va.calls (called_at в периоде), атрибуция —
// calls.manager_id (кто звонил/принял звонок — НЕ обязательно current_manager_id
// сделки на данный момент, сделка могла быть переназначена; для «звонковых»
// метрик это осознанно так же, как в managerCard.ts::fetchCallsTizer). ──────────
export interface CallsBaseRow {
  count: Bucket;                    // 1. Кол-во звонков (любой результат)
  outDurationMin: Bucket;           // 2. Длительность исходящих, мин (только completed)
  inDurationMin: Bucket;            // 3. Длительность входящих, мин (только completed)
  completedDurationSumMin: Bucket;  // служебное: числитель ср. длительности (4)
  completedCount: Bucket;           // служебное: знаменатель ср. длительности (4)
  medianDurationMin: Bucket;        // 5. Медианная длительность разговора, мин (прямой percentile_cont)
  outboundCount: Bucket;            // служебное: знаменатель доли недозвонов (9)
  missedOutboundCount: Bucket;      // служебное: числитель доли недозвонов (9)
}

/**
 * ОДИН агрегатный запрос (GROUPING SETS — «(все)» считается той же группировкой,
 * без второго прохода по va.calls): CTE call_deals — LEFT JOIN звонков на сделки/
 * воронки (LEFT — чтобы «сироты», если появятся, не терялись, а попадали в
 * is_repeat IS NULL → rollup-строку «(все)»). Один SEQ SCAN va.calls (индекса на
 * called_at нет — таблица ~200k строк, живой EXPLAIN ANALYZE 10.07: ~150ms).
 *
 * percentile_cont(FILTER) корректно работает с GROUPING SETS в PostgreSQL —
 * проверено живым запросом 10.07 (медиана «(все)» — НАСТОЯЩАЯ медиана по
 * объединённой выборке перв.+повт.+сироты, не среднее двух медиан).
 *
 * Возвращает null, если ВЕСЬ период раньше CALLS_DATA_START (честный null).
 */
export async function fetchCallsBaseMetrics(
  period: DateRange,
  managerIds?: string[],
): Promise<Map<string, CallsBaseRow> | null> {
  // periodDateStrFromInstant — тот же UTC-сдвиг, что чинили в план-метриках (8a4ab37,
  // задача 1595) и managerActivity.ts (задача 1610).
  const periodToStr = periodDateStrFromInstant(period.to, 'to');
  if (periodToStr < CALLS_DATA_START) return null;

  const { from, toExcl } = toSqlInterval(period);
  const params: unknown[] = [from, toExcl];
  let scopeWhere = '';
  if (managerIds && managerIds.length > 0) {
    params.push(managerIds);
    scopeWhere = managerScopeSql(managerIds, 'c.manager_id', params.length);
  }

  // GROUPING SETS расширены на 2 уровня (задача 10.07, п.7 — «Итого» для медианных
  // метрик): (is_repeat) и () — то же самое, что и раньше, но БЕЗ manager_id в группе,
  // т.е. «медиана/сумма по ВСЕМ звонкам, попавшим в scopeWhere» — единственный
  // способ получить НАСТОЯЩУЮ медиану по совокупности, а не среднее/медиану медиан
  // по менеджерам (percentile_cont не аддитивен). Один и тот же скан va.calls — не
  // второй проход, просто дополнительные строки в результате той же группировки.
  const sql = `
WITH call_deals AS (
  SELECT c.manager_id, c.direction, c.result, c.duration_seconds, f.is_repeat
  FROM va.calls c
  LEFT JOIN deals d ON d.deal_id = c.deal_id
  LEFT JOIN funnels f ON f.id = d.funnel_id
  WHERE c.called_at >= $1 AND c.called_at < $2 ${scopeWhere}
)
SELECT
  manager_id::text AS manager_id,
  is_repeat,
  GROUPING(is_repeat) AS is_all,
  GROUPING(manager_id) AS is_grand,
  count(*) AS calls_count,
  COALESCE(sum(duration_seconds) FILTER (WHERE direction = 'outbound' AND result = 'completed'), 0) AS out_duration_sum,
  COALESCE(sum(duration_seconds) FILTER (WHERE direction = 'inbound' AND result = 'completed'), 0) AS in_duration_sum,
  COALESCE(sum(duration_seconds) FILTER (WHERE result = 'completed'), 0) AS completed_duration_sum,
  count(*) FILTER (WHERE result = 'completed') AS completed_count,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_seconds) FILTER (WHERE result = 'completed') AS median_duration,
  count(*) FILTER (WHERE direction = 'outbound') AS outbound_count,
  count(*) FILTER (WHERE direction = 'outbound' AND result = 'missed') AS missed_outbound_count
FROM call_deals
GROUP BY GROUPING SETS ((manager_id, is_repeat), (manager_id), (is_repeat), ())
  `.trim();

  const res = await analyticsDb().query<{
    manager_id: string | null; is_repeat: boolean | null; is_all: number; is_grand: number;
    calls_count: string; out_duration_sum: string; in_duration_sum: string;
    completed_duration_sum: string; completed_count: string;
    median_duration: string | null; outbound_count: string; missed_outbound_count: string;
  }>(sql, params);

  const count = new Map<string, Bucket>();
  const outMin = new Map<string, Bucket>();
  const inMin = new Map<string, Bucket>();
  const compDurMin = new Map<string, Bucket>();
  const compCount = new Map<string, Bucket>();
  const medianMin = new Map<string, Bucket>();
  const outboundCount = new Map<string, Bucket>();
  const missedOutbound = new Map<string, Bucket>();
  const grandMedianMin = emptyBucket();

  for (const r of res.rows) {
    assignBucket(count, r, x => Number(x.calls_count));
    assignBucket(outMin, r, x => Number(x.out_duration_sum) / 60);
    assignBucket(inMin, r, x => Number(x.in_duration_sum) / 60);
    assignBucket(compDurMin, r, x => Number(x.completed_duration_sum) / 60);
    assignBucket(compCount, r, x => Number(x.completed_count));
    assignBucket(medianMin, r, x => x.median_duration !== null ? Number(x.median_duration) / 60 : 0);
    assignBucket(outboundCount, r, x => Number(x.outbound_count));
    assignBucket(missedOutbound, r, x => Number(x.missed_outbound_count));
    // «Итого» нас интересует ТОЛЬКО для медианной метрики (5) — остальные (суммы)
    // уже корректно бьются в «Итого» через computeTotals (aggregation_fn=sum).
    assignGrandBucket(grandMedianMin, r, x => x.median_duration !== null ? Number(x.median_duration) / 60 : 0);
  }

  const managerIdsOut = new Set(res.rows.map(r => r.manager_id).filter((id): id is string => id !== null));
  const out = new Map<string, CallsBaseRow>();
  for (const id of managerIdsOut) {
    out.set(id, {
      count: count.get(id) ?? emptyBucket(),
      outDurationMin: outMin.get(id) ?? emptyBucket(),
      inDurationMin: inMin.get(id) ?? emptyBucket(),
      completedDurationSumMin: compDurMin.get(id) ?? emptyBucket(),
      completedCount: compCount.get(id) ?? emptyBucket(),
      medianDurationMin: medianMin.get(id) ?? emptyBucket(),
      outboundCount: outboundCount.get(id) ?? emptyBucket(),
      missedOutboundCount: missedOutbound.get(id) ?? emptyBucket(),
    });
  }
  out.set(GRAND_TOTAL_KEY, {
    count: emptyBucket(), outDurationMin: emptyBucket(), inDurationMin: emptyBucket(),
    completedDurationSumMin: emptyBucket(), completedCount: emptyBucket(),
    medianDurationMin: grandMedianMin,
    outboundCount: emptyBucket(), missedOutboundCount: emptyBucket(),
  });
  return out;
}

// ── Метрики 8, 10: разрез по sa.deals, СОЗДАННЫМ В ПЕРИОДЕ (created_at), атрибуция
// — d.current_manager_id (это СДЕЛОЧНЫЕ метрики — «сколько звонков сделал КТО-ТО
// ДО брони ЭТОЙ сделки», «сколько СДЕЛОК менеджера осталось без звонка»). ─────────
export interface DealCallAdditiveRow {
  dealsNoCalls: Bucket;              // 10. Сделки без единого звонка
  dealsWithReservation: Bucket;      // служебное: знаменатель среднего (8)
  callsBeforeReservationSum: Bucket; // служебное: числитель среднего (8)
}

/**
 * ОДИН агрегатный запрос (GROUPING SETS, как и выше). «Сделки без звонка» —
 * LEFT JOIN на DISTINCT deal_id из va.calls (любой результат — «хоть один звонок»,
 * не только completed). «Звонков до брони» — считаем completed-звонки строго
 * между created_at и reserved_at (обе границы включительно), только для сделок,
 * у которых reserved_at заполнен (иначе понятие «до брони» не имеет смысла).
 * У сделки funnel_id резолвится всегда (INNER JOIN funnels) — «сирот» здесь нет,
 * поэтому rollup-строка (is_all=1) = perv+repeat ровно (проверено живым запросом
 * 10.07: 42+13=55 и т.п.).
 */
export async function fetchDealCallAdditive(period: DateRange): Promise<Map<string, DealCallAdditiveRow> | null> {
  // periodDateStrFromInstant — тот же UTC-сдвиг, что чинили в план-метриках (8a4ab37,
  // задача 1595) и managerActivity.ts (задача 1610).
  const periodToStr = periodDateStrFromInstant(period.to, 'to');
  if (periodToStr < CALLS_DATA_START) return null; // честный null — va.calls ещё не собиралась

  const { from, toExcl } = toSqlInterval(period);

  const sql = `
WITH period_deals AS (
  SELECT d.deal_id, d.current_manager_id AS manager_id, d.created_at, d.reserved_at, f.is_repeat
  FROM deals d
  JOIN funnels f ON f.id = d.funnel_id
  WHERE d.created_at >= $1 AND d.created_at < $2
    AND d.current_manager_id IS NOT NULL
),
calls_before_reservation AS (
  SELECT pd.deal_id, count(*) AS n
  FROM period_deals pd
  JOIN va.calls c ON c.deal_id = pd.deal_id AND c.result = 'completed'
    AND c.called_at >= pd.created_at AND c.called_at <= pd.reserved_at
  WHERE pd.reserved_at IS NOT NULL
  GROUP BY pd.deal_id
),
any_calls AS (SELECT DISTINCT deal_id FROM va.calls)
SELECT
  pd.manager_id::text AS manager_id,
  pd.is_repeat,
  GROUPING(pd.is_repeat) AS is_all,
  count(*) FILTER (WHERE ac.deal_id IS NULL) AS deals_no_calls,
  count(*) FILTER (WHERE pd.reserved_at IS NOT NULL) AS deals_with_reservation,
  COALESCE(sum(cbr.n) FILTER (WHERE pd.reserved_at IS NOT NULL), 0) AS calls_before_reservation_sum
FROM period_deals pd
LEFT JOIN any_calls ac ON ac.deal_id = pd.deal_id
LEFT JOIN calls_before_reservation cbr ON cbr.deal_id = pd.deal_id
GROUP BY GROUPING SETS ((pd.manager_id, pd.is_repeat), (pd.manager_id))
  `.trim();

  const res = await analyticsDb().query<{
    manager_id: string; is_repeat: boolean | null; is_all: number;
    deals_no_calls: string; deals_with_reservation: string; calls_before_reservation_sum: string;
  }>(sql, [from, toExcl]);

  const noCalls = new Map<string, Bucket>();
  const withReservation = new Map<string, Bucket>();
  const callsBeforeSum = new Map<string, Bucket>();

  for (const r of res.rows) {
    assignBucket(noCalls, r, x => Number(x.deals_no_calls));
    assignBucket(withReservation, r, x => Number(x.deals_with_reservation));
    assignBucket(callsBeforeSum, r, x => Number(x.calls_before_reservation_sum));
  }

  const managerIds = new Set(res.rows.map(r => r.manager_id));
  const out = new Map<string, DealCallAdditiveRow>();
  for (const id of managerIds) {
    out.set(id, {
      dealsNoCalls: noCalls.get(id) ?? emptyBucket(),
      dealsWithReservation: withReservation.get(id) ?? emptyBucket(),
      callsBeforeReservationSum: callsBeforeSum.get(id) ?? emptyBucket(),
    });
  }
  return out;
}

// ── Метрики 6, 7: медианы по СДЕЛКАМ, созданным в периоде, атрибуция —
// d.current_manager_id. Метрика 7 (скорость первого касания) — ТОТ ЖЕ расчёт,
// что уже жил в features/manager-card/engine/managerCard.ts (тизер карточки
// менеджера); вынесен сюда и переиспользуется обоими потребителями (задача 10.07,
// п.7: «уже есть в карточке менеджера — вынеси/переиспользуй расчёт»). Карточка
// менеджера использует только .all (без разреза перв./повт.) — см.
// managerCard.ts::fetchTouchSpeedByManagerUncached. ────────────────────────────
export interface TouchAndFirstCallRow {
  medianTouchMinutes: Bucket;         // 7. Скорость первого касания (медиана)
  medianFirstCallDurationMin: Bucket; // 6. Длительность первого разговора (медиана)
}

/**
 * ОДИН агрегатный запрос: «первый completed-звонок» сделки — CTE first_completed
 * (MIN(called_at) GROUP BY deal_id), джойн на сделки, созданные в периоде;
 * длительность ИМЕННО этого первого звонка — LATERAL (ORDER BY called_at ASC
 * LIMIT 1) по индексу idx_calls_deal_created_at (deal_id, created_at DESC) — план
 * живого EXPLAIN 10.07 использует Index Scan, не seq scan, по звонкам сделки.
 * Обе медианы — percentile_cont с той же GROUPING SETS-схемой, что и выше.
 *
 * fc.first_call_at >= d.created_at — тот же фильтр «звонок не раньше создания
 * сделки», что был в исходном managerCard.ts (защита от рассинхрона часов/дублей).
 */
export async function fetchTouchAndFirstCallMedians(
  period: DateRange,
  managerIds?: string[],
): Promise<Map<string, TouchAndFirstCallRow> | null> {
  // periodDateStrFromInstant — тот же UTC-сдвиг, что чинили в план-метриках (8a4ab37,
  // задача 1595) и managerActivity.ts (задача 1610).
  const periodToStr = periodDateStrFromInstant(period.to, 'to');
  if (periodToStr < CALLS_DATA_START) return null; // честный null — va.calls ещё не собиралась

  const { from, toExcl } = toSqlInterval(period);
  const params: unknown[] = [from, toExcl];
  let scopeWhere = '';
  if (managerIds && managerIds.length > 0) {
    params.push(managerIds);
    scopeWhere = managerScopeSql(managerIds, 'd.current_manager_id', params.length);
  }

  const sql = `
WITH period_deals AS (
  SELECT d.deal_id, d.current_manager_id AS manager_id, d.created_at, f.is_repeat
  FROM deals d
  JOIN funnels f ON f.id = d.funnel_id
  WHERE d.created_at >= $1 AND d.created_at < $2
    AND d.current_manager_id IS NOT NULL ${scopeWhere}
),
first_completed AS (
  SELECT deal_id, MIN(called_at) AS first_call_at
  FROM va.calls WHERE result = 'completed'
  GROUP BY deal_id
),
joined AS (
  SELECT pd.manager_id, pd.is_repeat,
         EXTRACT(EPOCH FROM (fc.first_call_at - pd.created_at)) / 60 AS touch_minutes,
         fcd.duration_seconds AS first_call_duration_sec
  FROM period_deals pd
  JOIN first_completed fc ON fc.deal_id = pd.deal_id AND fc.first_call_at >= pd.created_at
  LEFT JOIN LATERAL (
    SELECT c.duration_seconds FROM va.calls c
    WHERE c.deal_id = pd.deal_id AND c.result = 'completed'
    ORDER BY c.called_at ASC LIMIT 1
  ) fcd ON true
)
SELECT
  manager_id::text AS manager_id,
  is_repeat,
  GROUPING(is_repeat) AS is_all,
  GROUPING(manager_id) AS is_grand,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY touch_minutes) AS median_touch_minutes,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY first_call_duration_sec) AS median_first_call_duration_sec
FROM joined
GROUP BY GROUPING SETS ((manager_id, is_repeat), (manager_id), (is_repeat), ())
  `.trim();

  const res = await analyticsDb().query<{
    manager_id: string | null; is_repeat: boolean | null; is_all: number; is_grand: number;
    median_touch_minutes: string | null; median_first_call_duration_sec: string | null;
  }>(sql, params);

  const touch = new Map<string, Bucket>();
  const firstCallDur = new Map<string, Bucket>();
  const grandTouch = emptyBucket();
  const grandFirstCallDur = emptyBucket();
  for (const r of res.rows) {
    assignBucket(touch, r, x => x.median_touch_minutes !== null ? Number(x.median_touch_minutes) : 0);
    assignBucket(firstCallDur, r, x => x.median_first_call_duration_sec !== null ? Number(x.median_first_call_duration_sec) / 60 : 0);
    assignGrandBucket(grandTouch, r, x => x.median_touch_minutes !== null ? Number(x.median_touch_minutes) : 0);
    assignGrandBucket(grandFirstCallDur, r, x => x.median_first_call_duration_sec !== null ? Number(x.median_first_call_duration_sec) / 60 : 0);
  }

  const managerIdsOut = new Set(res.rows.map(r => r.manager_id).filter((id): id is string => id !== null));
  const out = new Map<string, TouchAndFirstCallRow>();
  for (const id of managerIdsOut) {
    out.set(id, {
      medianTouchMinutes: touch.get(id) ?? emptyBucket(),
      medianFirstCallDurationMin: firstCallDur.get(id) ?? emptyBucket(),
    });
  }
  out.set(GRAND_TOTAL_KEY, { medianTouchMinutes: grandTouch, medianFirstCallDurationMin: grandFirstCallDur });
  return out;
}

/**
 * Карточка менеджера (managerCard.ts) использует ТОЛЬКО «(все)» ветку — без
 * разреза перв./повт., как и было исторически (см. WORKLOG). Тонкая обёртка,
 * чтобы не дублировать SQL «скорости первого касания» в двух местах.
 */
export async function fetchTouchSpeedAllByManager(period: DateRange): Promise<Map<string, number> | null> {
  try {
    const rows = await fetchTouchAndFirstCallMedians(period);
    if (rows === null) return null; // период целиком раньше CALLS_DATA_START — честный null
    // Присутствие менеджера в rows означает, что была хотя бы 1 сделка с первым
    // касанием (INNER JOIN first_completed внутри запроса) — percentile_cont по
    // непустой выборке никогда не даёт null, поэтому наличие ключа само по себе
    // — признак «есть данные» (значение 0 мин теоретически валидно, не путать
    // с «нет данных»).
    const out = new Map<string, number>();
    for (const [id, row] of rows) {
      if (id === GRAND_TOTAL_KEY) continue; // не менеджер — общий итог, сюда не подмешиваем
      out.set(id, row.medianTouchMinutes.all);
    }
    return out;
  } catch (e) {
    console.warn('[calls-metrics] va.calls (touch speed) недоступна:', e instanceof Error ? e.message : e);
    return null;
  }
}

// ── Метрика 11 «Тишина»: СНИМОК на конец периода (period.to), НЕ привязана к
// сделкам, созданным в периоде, — это срез ВСЕХ открытых сделок менеджера на
// текущий момент времени истории (deals не версионируются, поэтому «на конец
// периода» технически означает «сейчас», с окном тишины, отсчитанным от
// periodTo). Атрибуция — d.current_manager_id. Открыта = НЕ продана/НЕ отгружена/
// НЕ отказ (sold_at/delivered_at/lost_at IS NULL — та же семантика, что sales_count/
// shipments_count/lost_deals_count в каталоге, см. metrics.date_field). ───────────
export async function fetchCallSilence(
  periodTo: Date,
  windowDays: number = SILENCE_WINDOW_DAYS,
): Promise<Map<string, Bucket> | null> {
  const silenceToExcl = addDays(startOfDay(periodTo), 1).toISOString();
  const silenceFrom = subDays(startOfDay(periodTo), windowDays - 1).toISOString();

  // Если всё окно «тишины» целиком раньше начала сбора va.calls — «нет звонков»
  // означало бы «нет данных», а не реальное молчание менеджера. Честный null
  // (тот же принцип, что CALLS_DATA_START в остальных функциях файла).
  if (silenceFrom.slice(0, 10) < CALLS_DATA_START) return null;

  const sql = `
SELECT
  d.current_manager_id::text AS manager_id,
  f.is_repeat,
  GROUPING(f.is_repeat) AS is_all,
  count(*) AS silent_count
FROM deals d
JOIN funnels f ON f.id = d.funnel_id
WHERE d.current_manager_id IS NOT NULL
  AND d.sold_at IS NULL AND d.delivered_at IS NULL AND d.lost_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM va.calls c
    WHERE c.deal_id = d.deal_id AND c.called_at >= $1 AND c.called_at < $2
  )
GROUP BY GROUPING SETS ((d.current_manager_id, f.is_repeat), (d.current_manager_id))
  `.trim();

  const res = await analyticsDb().query<{
    manager_id: string; is_repeat: boolean | null; is_all: number; silent_count: string;
  }>(sql, [silenceFrom, silenceToExcl]);

  const out = new Map<string, Bucket>();
  for (const r of res.rows) {
    assignBucket(out, r, x => Number(x.silent_count));
  }
  return out;
}

// ── Доля звонков-«сирот» (deal_id без соответствующей sa.deals) — для наблюдаемости
// (задача 10.07 просила «отметь их долю»), не самостоятельная метрика каталога.
// Живой прогон 10.07: 0 из 197 488 (join coverage 100%) — функция оставлена на
// случай появления таких звонков в будущем (не хардкодим 0%).
export async function fetchOrphanCallsShare(period: DateRange): Promise<{ total: number; orphan: number; sharePct: number } | null> {
  try {
    const { from, toExcl } = toSqlInterval(period);
    const res = await analyticsDb().query<{ total: string; orphan: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE d.deal_id IS NULL) AS orphan
       FROM va.calls c
       LEFT JOIN deals d ON d.deal_id = c.deal_id
       WHERE c.called_at >= $1 AND c.called_at < $2`,
      [from, toExcl],
    );
    const row = res.rows[0];
    if (!row) return { total: 0, orphan: 0, sharePct: 0 };
    const total = Number(row.total);
    const orphan = Number(row.orphan);
    return { total, orphan, sharePct: total > 0 ? Math.round((orphan / total) * 1000) / 10 : 0 };
  } catch {
    return null;
  }
}
