import type { Metric } from '../metrics/types';
import { isWorkingDayJs } from '../metrics/productionCalendar';
import { regionOf, type Region } from './region';

// Группа «Звонки» в «Сводке по логистам» и «Регионах» (задача #8314, Сергей Афанасьев:
// «добавить метрики по звонкам: кол-во, время исходящих и входящих, что ещё можно»).
// Данные — va.calls_logist (звонки логистов из Битрикса, копятся с 30.09.2026 17:52 МСК).
// Ключ звонка к логисту — portal_user_id = Bitrix id; логист в отчёте — пользователь 1С
// (sd.users_1c). Мост — va.logist_bitrix_map (задача #8357, схема va Сергея Афанасьева):
// строка = логист 1С на учётке Битрикса в интервале [valid_from, valid_to). Звонок относится
// к логисту, за которым учётка закреплена в момент started_at. Карта в базе не допускает двух
// логистов на одной учётке в один момент (триггер), поэтому звонок попадает ровно в одну
// строку отчёта — «Итого» и подытоги регионов без двойного счёта. Общих учёток больше нет.
//
// Здесь только чистые функции без БД: SQL-текст, раскладка агрегата по метрикам,
// рабочие дни — их проверяет scripts/assert-realizations.ts.

export const CALLS_DATA_FROM = '2026-09-30';
export const CALL_CATEGORY = 'Реализация: логисты';
/** Звонок «состоялся» — код Битрикса 200 (остальное — не дозвонились / сброс / пропуск). */
export const ANSWERED_CODE = '200';
/** failed_code в va.calls_logist — text; сравниваем строкой (и в SQL, и в JS). */
export const isAnsweredCode = (code: string | number | null | undefined) => code !== null && code !== undefined && String(code).trim() === ANSWERED_CODE;
const ANSWERED_SQL = `'${ANSWERED_CODE}'`;
export const SHORT_CALL_SEC = 10;

// ── Агрегат по ключу (логист 1С или регион) ─────────────────────────────────
// $1, $2 — даты периода по Москве (включительно); $3 — id логиста 1С, $4 — ключ строки
// (параллельные массивы: какой строке отчёта принадлежат звонки этого логиста).
// Граница по started_at (индекс idx_calls_logist_started), сутки — московские.
// grouping sets: строка на ключ + общая строка «Итого» (is_total) — уникальные номера
// в «Итого» считаются по всей совокупности, а не суммой строк.
/** Звонок c → строка карты lm, действующая в момент звонка (valid_to не включается). */
export const MAP_ON = `lm.bitrix_user_id = c.portal_user_id and c.started_at >= lm.valid_from and (lm.valid_to is null or c.started_at < lm.valid_to)`;

export const SQL_CALL_AGG = `
with m(lid, k) as (select * from unnest($3::text[], $4::text[]))
select m.k, (grouping(m.k) = 1) is_total,
  count(*)::int total,
  count(*) filter (where c.direction = 'outbound')::int n_out,
  count(*) filter (where c.direction = 'inbound')::int n_in,
  coalesce(sum(c.duration_seconds) filter (where c.direction = 'outbound' and c.failed_code = ${ANSWERED_SQL}), 0)::float8 sec_out,
  coalesce(sum(c.duration_seconds) filter (where c.direction = 'inbound' and c.failed_code = ${ANSWERED_SQL}), 0)::float8 sec_in,
  count(*) filter (where c.failed_code = ${ANSWERED_SQL})::int answered,
  coalesce(sum(c.duration_seconds) filter (where c.failed_code = ${ANSWERED_SQL}), 0)::float8 sec_answered,
  count(*) filter (where c.direction = 'inbound' and c.failed_code = ${ANSWERED_SQL})::int in_answered,
  count(*) filter (where c.direction = 'inbound' and c.failed_code is distinct from ${ANSWERED_SQL})::int in_missed,
  count(*) filter (where c.failed_code = ${ANSWERED_SQL} and c.duration_seconds < ${SHORT_CALL_SEC})::int short_n,
  count(*) filter (where c.failed_code = ${ANSWERED_SQL} and c.transcription_status = 'transcribed')::int transcribed_n,
  count(distinct c.phone)::int phones
from va.calls_logist c
join va.logist_bitrix_map lm on ${MAP_ON}
join m on m.lid = lm.logist_1c_id::text
where c.started_at >= ($1::date)::timestamp at time zone 'Europe/Moscow'
  and c.started_at < ($2::date + 1)::timestamp at time zone 'Europe/Moscow'
group by grouping sets ((m.k), ())`;

/** Карта логист 1С ↔ Bitrix с интервалами (имя — текущее из 1С). */
export const SQL_CALL_LOGIST_MAP = `
select m.logist_1c_id::text logist_id, m.bitrix_user_id::text bitrix_id, coalesce(u.name, m.logist_name) name,
  m.valid_from, m.valid_to
from va.logist_bitrix_map m left join sd.users_1c u on u.id = m.logist_1c_id`;

/** Список звонков для дрилла. $1,$2 — даты, $3 — id логистов 1С; условие метрики — CALL_DRILL_WHERE. */
export function sqlCallList(where: string): string {
  return `
select c.id::text id, c.started_at, c.direction, c.phone, c.duration_seconds, c.failed_code, c.failed_reason,
  c.transcription_status, lm.logist_1c_id::text logist_id
from va.calls_logist c
join va.logist_bitrix_map lm on ${MAP_ON}
where lm.logist_1c_id::text = any($3::text[])
  and c.started_at >= ($1::date)::timestamp at time zone 'Europe/Moscow'
  and c.started_at < ($2::date + 1)::timestamp at time zone 'Europe/Moscow'
  ${where ? `and ${where}` : ''}
order by c.started_at desc
limit 2000`;
}

export interface CallMapRow { logistId: string; bitrixId: string; name: string; validFrom: string; validTo: string | null }
export interface CallLogist { logistId: string; name: string; region: Region }

const msOf = (v: string | Date | null | undefined) => (v === null || v === undefined ? NaN : v instanceof Date ? v.getTime() : Date.parse(v));
const mskStart = (ymd: string) => Date.parse(`${ymd}T00:00:00+03:00`);

/** Строка SQL-карты → CallMapRow (даты — ISO). */
export function toCallMapRow(r: Record<string, unknown>): CallMapRow {
  const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());
  return { logistId: String(r.logist_id), bitrixId: String(r.bitrix_id), name: String(r.name ?? ''), validFrom: iso(r.valid_from) ?? '', validTo: iso(r.valid_to) };
}

/**
 * Логисты 1С, у которых в периоде (московские даты, включительно) была учётка Битрикса:
 * их строки отчёта получают числа (0, если звонков не было), остальные — «—».
 */
export function callLogists(map: CallMapRow[], fromYmd: string, toYmd: string): Map<string, CallLogist> {
  const lo = mskStart(fromYmd), hi = mskStart(toYmd) + 86_400_000;
  const out = new Map<string, CallLogist>();
  for (const r of map) {
    const f = msOf(r.validFrom), t = r.validTo === null ? Infinity : msOf(r.validTo);
    if (!/^\d+$/.test(r.bitrixId) || Number.isNaN(f) || !(f < hi && t > lo)) continue;
    if (!out.has(r.logistId)) out.set(r.logistId, { logistId: r.logistId, name: r.name, region: regionOf(r.name) });
  }
  return out;
}

/** Эталон резолва звонка на JS (то же, что MAP_ON в SQL): логист 1С на учётке в момент звонка. */
export function resolveCallLogist(map: CallMapRow[], bitrixId: string, startedAt: string | Date | null): string | null {
  const at = msOf(startedAt);
  if (Number.isNaN(at)) return null;
  const hits = map.filter(r => r.bitrixId === bitrixId && msOf(r.validFrom) <= at && (r.validTo === null || at < msOf(r.validTo)));
  return hits.length === 1 ? hits[0].logistId : null;
}

/** Рабочие дни (производственный календарь РФ) в периоде, обрезанном датой начала данных и сегодня. */
export function callWorkdays(fromYmd: string, toYmd: string, todayYmd: string, dataFrom = CALLS_DATA_FROM): number {
  const start = fromYmd > dataFrom ? fromYmd : dataFrom;
  const end = toYmd < todayYmd ? toYmd : todayYmd;
  if (start > end) return 0;
  let n = 0;
  for (let t = Date.parse(`${start}T00:00:00Z`), e = Date.parse(`${end}T00:00:00Z`); t <= e; t += 86_400_000) {
    const d = new Date(t);
    const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    if (isWorkingDayJs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), dow)) n++;
  }
  return n;
}

export interface CallAgg {
  total: number; nOut: number; nIn: number; secOut: number; secIn: number; answered: number; secAnswered: number;
  inAnswered: number; inMissed: number; shortN: number; transcribedN: number; phones: number;
}
export const EMPTY_CALL_AGG: CallAgg = { total: 0, nOut: 0, nIn: 0, secOut: 0, secIn: 0, answered: 0, secAnswered: 0, inAnswered: 0, inMissed: 0, shortN: 0, transcribedN: 0, phones: 0 };

export function toCallAgg(r: Record<string, unknown>): CallAgg {
  const n = (k: string) => Number(r[k] ?? 0) || 0;
  return {
    total: n('total'), nOut: n('n_out'), nIn: n('n_in'), secOut: n('sec_out'), secIn: n('sec_in'), answered: n('answered'),
    secAnswered: n('sec_answered'), inAnswered: n('in_answered'), inMissed: n('in_missed'), shortN: n('short_n'),
    transcribedN: n('transcribed_n'), phones: n('phones'),
  };
}

/**
 * Эталон агрегата на JS по сырым звонкам — та же семантика, что SQL_CALL_AGG. Нужен
 * тесту и сверке с живой базой (scripts/check-logist-calls.ts); в отчёте не используется.
 */
export function aggregateCallsJs(calls: { direction: string; duration_seconds: number | null; failed_code: string | number | null; transcription_status: string | null; phone: string | null }[]): CallAgg {
  const a = { ...EMPTY_CALL_AGG };
  const phones = new Set<string>();
  for (const c of calls) {
    const dur = Number(c.duration_seconds ?? 0);
    const ok = isAnsweredCode(c.failed_code);
    a.total++;
    // Минуты на линии — только состоявшиеся разговоры: у пропущенного Битрикс пишет время дозвона.
    if (c.direction === 'outbound') { a.nOut++; if (ok) a.secOut += dur; }
    if (c.direction === 'inbound') { a.nIn++; if (ok) { a.secIn += dur; a.inAnswered++; } else a.inMissed++; }
    if (ok) {
      a.answered++; a.secAnswered += dur;
      if (dur < SHORT_CALL_SEC) a.shortN++;
      if (c.transcription_status === 'transcribed') a.transcribedN++;
    }
    if (c.phone) phones.add(c.phone);
  }
  a.phones = phones.size;
  return a;
}

type Def = Pick<Metric, 'id' | 'nameRu' | 'nameShortRu' | 'dataType' | 'decimalPlaces' | 'aggregationFn' | 'description'>
  & Partial<Pick<Metric, 'metricType' | 'formula' | 'dependencies' | 'isHiddenInUi'>>
  & { get: (a: CallAgg, workdays: number) => number | null };

const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);
const OWNER = ' Звонок относится к логисту, за которым учётная запись Битрикса закреплена в момент звонка (учётки переходят от логиста к логисту — считается по дате звонка).';

const DEFS: Def[] = [
  { id: 'lc_total', nameRu: 'Звонков всего', nameShortRu: 'Всего', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', get: a => a.total,
    description: `Все звонки логиста в Битриксе за период — входящие и исходящие, состоявшиеся и нет. Данные есть с 30.09.2026.${OWNER}` },
  { id: 'lc_out', nameRu: 'Исходящих звонков', nameShortRu: 'Исходящих', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', get: a => a.nOut,
    description: 'Звонки, которые логист сделал сам, включая недозвоны.' },
  { id: 'lc_in', nameRu: 'Входящих звонков', nameShortRu: 'Входящих', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', get: a => a.nIn,
    description: 'Звонки логисту, включая пропущенные.' },
  { id: 'lc_out_min', nameRu: 'Минуты исходящих', nameShortRu: 'Исх., мин', dataType: 'decimal', decimalPlaces: 1, aggregationFn: 'sum', get: a => a.secOut / 60,
    description: 'Сколько минут логист проговорил в исходящих звонках: длительность состоявшихся разговоров по Битриксу (время дозвона без ответа не входит).' },
  { id: 'lc_in_min', nameRu: 'Минуты входящих', nameShortRu: 'Вх., мин', dataType: 'decimal', decimalPlaces: 1, aggregationFn: 'sum', get: a => a.secIn / 60,
    description: 'Сколько минут логист проговорил во входящих звонках: только состоявшиеся разговоры (время звонка, на который не ответили, не входит).' },
  { id: 'lc_answered', nameRu: 'Состоявшихся звонков (служебная)', nameShortRu: null, dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', isHiddenInUi: true, get: a => a.answered,
    description: 'Звонки с кодом Битрикса 200 — разговор состоялся.' },
  { id: 'lc_talk_min', nameRu: 'Минуты состоявшихся разговоров (служебная)', nameShortRu: null, dataType: 'decimal', decimalPlaces: 1, aggregationFn: 'sum', isHiddenInUi: true, get: a => a.secAnswered / 60,
    description: 'Сумма длительности состоявшихся звонков, мин.' },
  { id: 'lc_avg_talk_min', nameRu: 'Средний разговор, мин', nameShortRu: 'Ср. разговор, мин', dataType: 'decimal', decimalPlaces: 1, aggregationFn: 'avg',
    metricType: 'calculated', formula: '[lc_talk_min] / [lc_answered]', dependencies: ['lc_talk_min', 'lc_answered'],
    get: a => (a.answered > 0 ? a.secAnswered / 60 / a.answered : null),
    description: 'Средняя длительность состоявшегося разговора (входящие и исходящие), мин.' },
  { id: 'lc_missed_in', nameRu: 'Пропущенные входящие', nameShortRu: 'Пропущено', dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', get: a => a.inMissed,
    description: 'Входящие звонки, на которые логист не ответил (код Битрикса не 200).' },
  { id: 'lc_in_answered', nameRu: 'Отвеченных входящих (служебная)', nameShortRu: null, dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', isHiddenInUi: true, get: a => a.inAnswered,
    description: 'Входящие звонки с кодом Битрикса 200.' },
  { id: 'lc_answered_in_pct', nameRu: 'Доля отвеченных входящих', nameShortRu: 'Отвечено, %', dataType: 'percent', decimalPlaces: 1, aggregationFn: 'avg',
    metricType: 'calculated', formula: '[lc_in_answered] / [lc_in] * 100', dependencies: ['lc_in_answered', 'lc_in'], get: a => pct(a.inAnswered, a.nIn),
    description: 'Отвеченные входящие от всех входящих звонков.' },
  { id: 'lc_phones', nameRu: 'Уникальных номеров', nameShortRu: 'Номеров', dataType: 'int', decimalPlaces: 0, aggregationFn: 'none', get: a => a.phones,
    description: 'Сколько разных телефонных номеров было в звонках логиста. В «Итого» — по всей совокупности, номер у двух логистов считается один раз.' },
  // Внешняя «сумма», не формула: рабочие дни у всех строк одни и те же, поэтому сумма
  // дневных показателей логистов = звонки региона в день (подытог считается честно).
  { id: 'lc_per_workday', nameRu: 'Звонков в рабочий день', nameShortRu: 'В рабочий день', dataType: 'decimal', decimalPlaces: 1, aggregationFn: 'sum',
    get: (a, w) => (w > 0 ? a.total / w : null),
    description: 'Звонков всего, делённое на рабочие дни периода (производственный календарь РФ; дни до 30.09.2026 и после сегодня не считаются). У региона и в «Итого» — звонки всех логистов в день.' },
  { id: 'lc_short_n', nameRu: 'Коротких разговоров (служебная)', nameShortRu: null, dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', isHiddenInUi: true, get: a => a.shortN,
    description: 'Состоявшиеся звонки короче 10 секунд.' },
  { id: 'lc_short_pct', nameRu: 'Доля коротких разговоров (< 10 с)', nameShortRu: 'Короткие, %', dataType: 'percent', decimalPlaces: 1, aggregationFn: 'avg',
    metricType: 'calculated', formula: '[lc_short_n] / [lc_answered] * 100', dependencies: ['lc_short_n', 'lc_answered'], get: a => pct(a.shortN, a.answered),
    description: 'Состоявшиеся звонки короче 10 секунд от всех состоявшихся: сброс, «перезвоню», ошиблись номером.' },
  { id: 'lc_transcribed_n', nameRu: 'С транскрипцией (служебная)', nameShortRu: null, dataType: 'int', decimalPlaces: 0, aggregationFn: 'sum', isHiddenInUi: true, get: a => a.transcribedN,
    description: 'Состоявшиеся звонки, по которым готова расшифровка разговора.' },
  { id: 'lc_transcribed_pct', nameRu: 'Доля с транскрипцией', nameShortRu: 'Расшифровано, %', dataType: 'percent', decimalPlaces: 1, aggregationFn: 'avg',
    metricType: 'calculated', formula: '[lc_transcribed_n] / [lc_answered] * 100', dependencies: ['lc_transcribed_n', 'lc_answered'], get: a => pct(a.transcribedN, a.answered),
    description: 'Состоявшиеся звонки с готовой расшифровкой от всех состоявшихся. Свежие звонки ещё в очереди на расшифровку.' },
];

export const CALL_METRICS: Metric[] = DEFS.map((d, i) => ({
  id: d.id, nameRu: d.nameRu, nameShortRu: d.nameShortRu, description: d.description,
  humanDescription: d.description, formulaHuman: null,
  calcOk: true, fillOk: true,
  metricType: d.metricType ?? 'external', dataType: d.dataType, formula: d.formula ?? null,
  dependencies: d.dependencies ?? [], decimalPlaces: d.decimalPlaces, aggregationFn: d.aggregationFn,
  category: CALL_CATEGORY, sortOrder: 6100 + i,
  isCore: false, isActive: true, isHiddenInUi: d.isHiddenInUi ?? false, isTest: false,
  source: 'deals', aggFn: null, aggField: null, dateField: null, filters: [], tags: ['realizations', 'calls'],
  isCollectOk: true, isCalcOk: true, color: null,
}));
export const CALL_METRIC_IDS = CALL_METRICS.map(m => m.id);

/** Агрегат → значения метрик строки. agg = null — у логиста в периоде нет учётки Битрикса: «—». */
export function callAggToMetrics(agg: CallAgg | null, workdays: number): Record<string, number | null> {
  return Object.fromEntries(DEFS.map(d => [d.id, agg ? d.get(agg, workdays) : null]));
}

export const CALL_COLUMN_GROUP = {
  name: 'Звонки',
  metricIds: ['lc_total', 'lc_out', 'lc_in', 'lc_out_min', 'lc_in_min', 'lc_avg_talk_min', 'lc_missed_in', 'lc_answered_in_pct', 'lc_phones', 'lc_per_workday', 'lc_short_pct', 'lc_transcribed_pct'],
};

// ── Дрилл «список звонков» ──────────────────────────────────────────────────
// Ячейка метрики → условие списка (население числа). Доли и минуты открывают
// ту совокупность, из которой считаются.
export const CALL_DRILL_WHERE: Record<string, { where: string; note?: string }> = {
  lc_out: { where: `c.direction = 'outbound'` },
  lc_out_min: { where: `c.direction = 'outbound'` },
  lc_in: { where: `c.direction = 'inbound'` },
  lc_in_min: { where: `c.direction = 'inbound'` },
  lc_answered_in_pct: { where: `c.direction = 'inbound'`, note: 'все входящие — база доли' },
  lc_missed_in: { where: `c.direction = 'inbound' and c.failed_code is distinct from ${ANSWERED_SQL}` },
  lc_avg_talk_min: { where: `c.failed_code = ${ANSWERED_SQL}`, note: 'состоявшиеся разговоры' },
  lc_short_pct: { where: `c.failed_code = ${ANSWERED_SQL}`, note: 'состоявшиеся — база доли; короткие помечены' },
  lc_transcribed_pct: { where: `c.failed_code = ${ANSWERED_SQL}`, note: 'состоявшиеся — база доли' },
};
export function callDrillWhere(metricId: string | null | undefined): { where: string; note?: string } {
  return (metricId && CALL_DRILL_WHERE[metricId]) || { where: '' };
}
export const isCallMetric = (id: string | null | undefined) => !!id && id.startsWith('lc_');

/** Номер телефона — ПДн: наружу только последние 4 цифры. */
export function maskPhone(phone: string | null | undefined): string | null {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length <= 4) return '••••';
  return `••• ${d.slice(-4, -2)}-${d.slice(-2)}`;
}
