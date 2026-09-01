// «Доля прозвона броней / подтв. броней на следующий рабочий день» (задача Иосифа
// 17.07). Регламент: менеджер, переведший сделку в бронь (reserved) или подтв. бронь
// (confirmed), обязан прозвонить клиента В СЛЕДУЮЩИЙ рабочий день (вариант Б —
// СТРОГО в него, не в день перевода; выбор владельца).
//
// Знаменатель: сделки с reserved_at (confirmed_at) в периоде отчёта, атрибуция по
//   current_manager_id (как все by-managers метрики). Незавершённое окно исключаем:
//   если конец следующего рабочего дня ещё не наступил (now), сделка в знаменатель
//   не идёт — иначе штрафуем за не наступивший срок.
// Числитель: из них те, где ∃ ИСХОДЯЩИЙ звонок по сделке (va.calls.deal_id,
//   direction='outbound') с called_at ВНУТРИ следующего рабочего дня [00:00, 23:59:59] МСК.
//   Звонок любого сотрудника (клиенту перезвонили — регламент соблюдён).
//
// Кросс-БД: брони+звонки из sa (analyticsDb), рабочий календарь из system (systemDb) —
// джойна нет, следующий рабочий день считаем в приложении. Данные звонков — с
// CALLS_DATA_START; если ВЕСЬ период раньше → null (честный, как в callsMetrics).

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { CALLS_DATA_START } from '@/features/reports/engine/callsMetrics';
import { periodDateStrFromInstant, type DateRange } from '@/lib/period';
import { buildCommonDealWhere, type CommonDealFilterOpts } from './commonDealWhere';

// Сделочные фильтры отчёта (физики/юрики, товарные группы, время создания,
// первое касание, «Фильтр сделок») — общий хвост WHERE (аудит владельца 31.08:
// «все метрики должны подчиняться фильтрации отчёта»; жалоба-триггер была про
// физиков/юриков именно у этой метрики).

export interface BookingCallRateRow {
  reservedDenom: number;
  reservedNum: number;
  confirmedDenom: number;
  confirmedNum: number;
}

const MSK = 'Europe/Moscow';
const mskDay = (d: Date): string => d.toLocaleDateString('sv-SE', { timeZone: MSK }); // YYYY-MM-DD

/** Карта «следующий рабочий день» по календарю system (нет записи → считаем будни:
 *  пн–пт рабочие). Возвращает функцию dateStr → следующий рабочий dateStr. */
async function loadNextWorkingDayFn(): Promise<(dateStr: string) => string> {
  const res = await systemDb().query<{ d: string; is_working: boolean }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS d, is_working FROM working_calendar`,
  );
  const cal = new Map(res.rows.map(r => [r.d, r.is_working]));
  const isWorking = (s: string): boolean => {
    const v = cal.get(s);
    if (v !== undefined) return v;
    const dow = new Date(`${s}T12:00:00Z`).getUTCDay(); // нет в календаре → будни
    return dow !== 0 && dow !== 6;
  };
  return (dateStr: string): string => {
    const d = new Date(`${dateStr}T12:00:00Z`);
    for (let i = 0; i < 21; i++) {
      d.setUTCDate(d.getUTCDate() + 1);
      const s = d.toISOString().slice(0, 10);
      if (isWorking(s)) return s;
    }
    return dateStr; // защита от зацикливания (не должно случаться)
  };
}

export async function fetchBookingCallRate(period: DateRange, filters: CommonDealFilterOpts = {}): Promise<Map<string, BookingCallRateRow> | null> {
  const fromStr = periodDateStrFromInstant(period.from, 'from');
  const toStr = periodDateStrFromInstant(period.to, 'to');
  // Весь период раньше старта сбора звонков — числитель был бы всегда 0, это ложь.
  if (toStr < CALLS_DATA_START) return null;

  const sa = analyticsDb();
  const nextWorkingDay = await loadNextWorkingDayFn();
  const now = new Date();
  const out = new Map<string, BookingCallRateRow>();
  const ensure = (mgr: string) => {
    let r = out.get(mgr);
    if (!r) { r = { reservedDenom: 0, reservedNum: 0, confirmedDenom: 0, confirmedNum: 0 }; out.set(mgr, r); }
    return r;
  };

  for (const milestone of ['reserved_at', 'confirmed_at'] as const) {
    // Брони периода. Полуинтервал [from, to+1day) МСК — как везде в отчётах.
    const cw = buildCommonDealWhere(filters, 2);
    const deals = await sa.query<{ deal_id: string; mgr: number; at: Date }>(
      `SELECT d.deal_id, d.current_manager_id AS mgr, d.${milestone} AS at
       FROM sa.deals d
       WHERE d.current_manager_id IS NOT NULL
         AND d.${milestone} >= ($1 || 'T00:00:00+03:00')::timestamptz
         AND d.${milestone} <  (($2 || 'T00:00:00+03:00')::timestamptz + interval '1 day')${cw.sql ? ` AND ${cw.sql}` : ''}`,
      [fromStr, toStr, ...cw.params],
    );
    if (deals.rows.length === 0) continue;

    const dealIds = deals.rows.map(r => Number(r.deal_id));
    // Исходящие звонки по этим сделкам (один запрос). deal_id в va.calls — bigint →
    // node-pg отдаёт строкой; ключуем Map строкой (иначе не сматчится с sa.deals).
    const calls = await sa.query<{ deal_id: string; called_at: Date }>(
      `SELECT deal_id, called_at FROM va.calls
       WHERE deal_id = ANY($1) AND direction::text = 'outbound'`,
      [dealIds],
    );
    const callsByDeal = new Map<string, Date[]>();
    for (const c of calls.rows) {
      const k = String(c.deal_id);
      const arr = callsByDeal.get(k);
      if (arr) arr.push(new Date(c.called_at)); else callsByDeal.set(k, [new Date(c.called_at)]);
    }

    for (const d of deals.rows) {
      const nwd = nextWorkingDay(mskDay(new Date(d.at)));
      const winStart = new Date(`${nwd}T00:00:00+03:00`);
      const winEnd = new Date(`${nwd}T23:59:59.999+03:00`);
      // Окно ещё не завершилось — срок не наступил, из знаменателя исключаем.
      if (winEnd > now) continue;
      const r = ensure(String(d.mgr));
      const dealCalls = callsByDeal.get(String(d.deal_id)) ?? [];
      const called = dealCalls.some(t => t >= winStart && t <= winEnd);
      if (milestone === 'reserved_at') { r.reservedDenom++; if (called) r.reservedNum++; }
      else { r.confirmedDenom++; if (called) r.confirmedNum++; }
    }
  }

  return out;
}

// ── График «Доли прозвона» по времени (задача владельца 24.08) ───────────────
// Владелец: «я бы хотел смотреть её тенденцию в выбранном периоде в виде
// графика. А мы не можем. Может всё-таки можем?)» — можем: универсальная
// разбивка (metricSeries/buildCollectedSQL) этой метрике действительно не
// подходит, но её собственный движок выше и так перебирает сделки ПОШТУЧНО с
// датой вехи на руках — сбакетить их по дням/неделям/месяцам тривиально.
//
// Контракт тот же, что у fetchMetricSeries: сумма числителей/знаменателей всех
// бакетов обязана сходиться с ячейкой отчёта (никаких параллельных формул —
// цикл по сделкам ниже в точности повторяет fetchBookingCallRate, включая
// исключение незавершённых окон). Бакет сделки — дата ВЕХИ (reserved_at/
// confirmed_at) в МСК: регламент привязан ко дню перевода в бронь, человек на
// графике читает «брони этого дня прозвонили на N%».

import { bucketStartYmd, nextBucketYmd, type SeriesGranularity, type MetricSeriesResult, type SeriesBucket } from './metricSeries';

/** Метрики, чей график строит этот движок (metricId → веха). */
export const BOOKING_SERIES_METRICS: Record<string, 'reserved_at' | 'confirmed_at'> = {
  booking_call_rate_reserved: 'reserved_at',
  booking_call_rate_confirmed: 'confirmed_at',
};

export async function fetchBookingCallRateSeries(opts: {
  metricId: string;
  period: DateRange;
  granularity: SeriesGranularity;
  /** Явное ограничение строк — как в fetchMetricSeries (для строки менеджера
   *  один id, для Итого/отдела — участники видимого отчёта). */
  managerIds?: string[];
  filters?: CommonDealFilterOpts;
}): Promise<MetricSeriesResult> {
  const milestone = BOOKING_SERIES_METRICS[opts.metricId];
  if (!milestone) return { supported: false, reason: 'Не метрика прозвона броней', buckets: [], cumulativeBuckets: [], total: null };

  const fromStr = periodDateStrFromInstant(opts.period.from, 'from');
  const toStr = periodDateStrFromInstant(opts.period.to, 'to');
  if (toStr < CALLS_DATA_START) {
    return { supported: false, reason: `Данные звонков собираются с ${CALLS_DATA_START} — весь период раньше`, buckets: [], cumulativeBuckets: [], total: null };
  }

  const sa = analyticsDb();
  const nextWorkingDay = await loadNextWorkingDayFn();
  const now = new Date();
  const mgrSet = opts.managerIds?.length ? new Set(opts.managerIds) : null;

  const cw = buildCommonDealWhere(opts.filters ?? {}, 2);
  const deals = await sa.query<{ deal_id: string; mgr: number; at: Date }>(
    `SELECT d.deal_id, d.current_manager_id AS mgr, d.${milestone} AS at
     FROM sa.deals d
     WHERE d.current_manager_id IS NOT NULL
       AND d.${milestone} >= ($1 || 'T00:00:00+03:00')::timestamptz
       AND d.${milestone} <  (($2 || 'T00:00:00+03:00')::timestamptz + interval '1 day')${cw.sql ? ` AND ${cw.sql}` : ''}`,
    [fromStr, toStr, ...cw.params],
  );
  const rows = mgrSet ? deals.rows.filter(d => mgrSet.has(String(d.mgr))) : deals.rows;

  const callsByDeal = new Map<string, Date[]>();
  if (rows.length > 0) {
    const calls = await sa.query<{ deal_id: string; called_at: Date }>(
      `SELECT deal_id, called_at FROM va.calls
       WHERE deal_id = ANY($1) AND direction::text = 'outbound'`,
      [rows.map(r => Number(r.deal_id))],
    );
    for (const c of calls.rows) {
      const k = String(c.deal_id);
      const arr = callsByDeal.get(k);
      if (arr) arr.push(new Date(c.called_at)); else callsByDeal.set(k, [new Date(c.called_at)]);
    }
  }

  // num/denom по бакетам — бакет определяет дата вехи.
  const agg = new Map<string, { num: number; denom: number }>();
  let totNum = 0, totDenom = 0;
  for (const d of rows) {
    const at = new Date(d.at);
    const nwd = nextWorkingDay(mskDay(at));
    const winStart = new Date(`${nwd}T00:00:00+03:00`);
    const winEnd = new Date(`${nwd}T23:59:59.999+03:00`);
    if (winEnd > now) continue; // срок ещё не наступил — как в ячейке
    const b = bucketStartYmd(at, opts.granularity);
    let e = agg.get(b);
    if (!e) { e = { num: 0, denom: 0 }; agg.set(b, e); }
    e.denom++; totDenom++;
    const called = (callsByDeal.get(String(d.deal_id)) ?? []).some(t => t >= winStart && t <= winEnd);
    if (called) { e.num++; totNum++; }
  }

  // Непрерывная шкала бакетов периода. denom=0 → null, а не 0%: «в этот день
  // броней не было» и «прозвонили 0%» — разные вещи, линия не должна нырять в
  // ноль на выходных. Бакеты целиком раньше старта сбора звонков — тоже null
  // (числитель там был бы враньём).
  const startYmd = bucketStartYmd(opts.period.from, opts.granularity);
  const endExcl = new Date(`${toStr}T00:00:00+03:00`);
  endExcl.setUTCDate(endExcl.getUTCDate() + 1);
  const endExclYmd = bucketStartYmd(endExcl, 'day');
  const buckets: SeriesBucket[] = [];
  // «С накоплением» (правка владельца 24.08): накапливаются ЧИСЛИТЕЛЬ и
  // ЗНАМЕНАТЕЛЬ, процент считается от накопленного — «доля прозвона нарастающим
  // итогом с начала периода». Складывать сами проценты по дням нельзя.
  const cumulativeBuckets: SeriesBucket[] = [];
  let cumNum = 0, cumDenom = 0;
  for (let b = startYmd; b < endExclYmd && buckets.length < 500; b = nextBucketYmd(b, opts.granularity)) {
    const e = agg.get(b);
    const beforeCalls = nextBucketYmd(b, opts.granularity) <= CALLS_DATA_START;
    buckets.push({ bucket: b, value: !beforeCalls && e && e.denom > 0 ? (e.num / e.denom) * 100 : null });
    if (!beforeCalls && e) { cumNum += e.num; cumDenom += e.denom; }
    cumulativeBuckets.push({ bucket: b, value: cumDenom > 0 ? (cumNum / cumDenom) * 100 : null });
  }

  return { supported: true, buckets, cumulativeBuckets, total: totDenom > 0 ? (totNum / totDenom) * 100 : null };
}
