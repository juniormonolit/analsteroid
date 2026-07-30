import { analyticsDb } from '@/lib/db/clients';
import { toSqlInterval, periodDateStrFromInstant } from '@/lib/period';
import { DEAL_EVENTS_DATA_START } from '@/features/reports/engine/managerActivity';
import { buildProductGroupFilter } from '@/features/reports/engine/productGroupFilter';
import { scopeWhere, departmentsWhere, fetchWorkRows, RESERVED_CONFIRMED_EVENT_TYPES, type SurvivalRowOptions } from './stageSurvival';
import { buildLifeTablePoints, selectLifeTableDealIds, type LifeTableRow } from './lifeTable';
import type { MilestoneCohortResult, MilestoneCohortPoint } from './types';

export type { MilestoneCohortResult, MilestoneCohortPoint } from './types';

// Пятый график — ИСТОРИЯ ДВУХ ДОРАБОТОК ПОСЛЕ ПЕРВОЙ ВЕРСИИ (задача 2574):
//  v1 (28.07): бакеты/CR% по образцу preset='work' (stageSurvival.ts).
//  v2 (29.07, владелец посмотрел v1): «поправь чтобы был по аналогии с 3 и 4,
//    то есть от общего количества сделок» — подача life table вместо бакетов.
//  v3 (30.07, владелец дополнил v2 ДО показа): «показывай не только продажу,
//    но и бронь/отгрузку — на какой день конверсия в бронь/продажу/отгрузку
//    ничтожна». Вместо ОДНОЙ линии («продано на день N») — ТРИ линии:
//    reserved (d.reserved_at) / sold (d.sold_at) / shipped (d.delivered_at).
//    Серые столбики когорты («дожили минимум N дней») общие на все три —
//    та же величина, что была бы у одной линии в v2.
//
// Когорта — ТА ЖЕ, что у preset='work'/4-го графика (первый вход в любую
// WORK-стадию). «День» — накопленное время в WORK-стадиях БЕЗ интервалов
// event_type IN ('reserved','confirmed') (см. stageSurvival.ts fetchWorkRows) —
// та же шкала дней, что была в v1/v2, без изменений.
//
// ВАЖНО (одна и та же сделка в разных линиях): сделка обычно проходит
// бронь → продажу → отгрузку в РАЗНЫЕ дни этой шкалы, поэтому попадает в
// каждую из трёх линий на СВОЕЙ точке — сумма трёх линий НЕ равна когорте,
// линии друг из друга не вычитаются. Это ожидаемо и отражено в подписи под
// графиком (ChartsPage.tsx). На живых данных (30.07, когорта 'work' preset,
// «Первичные», весь период) встречаются редкие нарушения порядка
// бронь→продажа→отгрузка (бронь позже продажи, отгрузка без продажи) — это
// НЕ баг движка (данные с портала как есть), количество проверено отдельно
// (см. отчёт задачи) и не выносится в UI по решению владельца («незаметное
// количество», подпись оставляем простой).
//
// Алгоритм раскладки по дням — тот же lifeTable.ts, что у 3-го/4-го графиков,
// вызванный ТРИ РАЗА (по разу на reserved/sold/shipped) с ОДНИМ и тем же
// observedDays (censoring), но разным eventDay — переиспользование, а не
// новый алгоритм.

export type WorkExclReservedCohortOptions = SurvivalRowOptions;

interface MilestoneDealRow {
  dealId: number;
  observedDays: number;         // floor(накопленное время в работе, без reserved/confirmed) — цензурирование, общее на все три линии
  reservedDay: number | null;   // floor(накопленное время в работе НА МОМЕНТ d.reserved_at), null — если брони не было
  soldDay: number | null;       // floor(…на момент d.sold_at)
  shippedDay: number | null;    // floor(…на момент d.delivered_at)
}

// Сегмент «реального рабочего времени» — та же единица, что суммирует
// fetchWorkRows (интервал WORK-стадии, исключая sold/shipped/reserved/confirmed,
// с event_at и концом seg_end = следующее событие сделки ИЛИ now(), если
// открыт). Возвращаем сырыми (не агрегированными), чтобы в JS посчитать
// «сколько реального рабочего времени накопилось к моменту T» для трёх РАЗНЫХ
// T (reserved_at/sold_at/delivered_at) на деле — SQL-агрегатом на трёх разных
// точках отсечения пришлось бы либо тройным self-join, либо оконными
// функциями с ROWS BETWEEN, JS-цикл по уже отсортированным по deal_id+event_at
// строкам проще и дешевле по плану выполнения в Postgres.
async function fetchMilestoneRows(opts: WorkExclReservedCohortOptions): Promise<MilestoneDealRow[]> {
  const { from, toExcl } = toSqlInterval(opts.period);
  const cohortExcluded = ['sold', 'shipped'];
  const timeExcluded = [...cohortExcluded, ...RESERVED_CONFIRMED_EVENT_TYPES];
  const params: unknown[] = [from, toExcl, cohortExcluded, timeExcluded];
  let deptWhere = '';
  if (opts.departmentIds?.length) {
    params.push(opts.departmentIds);
    deptWhere = departmentsWhere(params.length);
  }
  let pgWhere = '';
  const pgFilter = buildProductGroupFilter(
    { productGroupMode: opts.productGroupMode, productGroupIds: opts.productGroupIds },
    params.length,
  );
  if (pgFilter) {
    params.push(...pgFilter.params);
    pgWhere = `AND ${pgFilter.sql}`;
  }

  const sql = `
WITH cohort_stages AS (
  SELECT id FROM stages WHERE stage_type = 'WORK' AND event_type <> ALL($3::text[])
),
time_stages AS (
  SELECT id FROM stages WHERE stage_type = 'WORK' AND event_type <> ALL($4::text[])
),
first_entry AS (
  SELECT DISTINCT ON (de.deal_id) de.deal_id, de.event_at AS first_at
  FROM deal_events de
  JOIN cohort_stages s ON s.id = de.stage_id
  ORDER BY de.deal_id, de.event_at ASC
),
cohort AS (
  -- Милстоуны считаются, ТОЛЬКО если случились НЕ РАНЬШЕ входа в эту когорту
  -- (fe.first_at) — та же граница, что sold-флаг в fetchWorkRows/stageSurvival.ts
  -- (\`d.sold_at >= c.first_at\`). Без неё сделка со СТАРЫМ sold_at/reserved_at
  -- (из предыдущего цикла работы, до текущего входа в WORK) ложно засчиталась
  -- бы «продана»/«забронирована» в ЭТОЙ когорте — soldTotal тогда не сходился
  -- бы с графиками 2/4 (найдено проверкой на живых данных 30.07: без этой
  -- границы soldTotal был 5571 против 5453 у графика 2/4 — 118 сделок лишних).
  SELECT fe.deal_id, fe.first_at,
    CASE WHEN d.reserved_at >= fe.first_at THEN d.reserved_at END AS reserved_at,
    CASE WHEN d.sold_at >= fe.first_at THEN d.sold_at END AS sold_at,
    CASE WHEN d.delivered_at >= fe.first_at THEN d.delivered_at END AS delivered_at
  FROM first_entry fe
  JOIN deals d ON d.deal_id = fe.deal_id
  JOIN funnels f ON f.id = d.funnel_id
  WHERE fe.first_at >= $1 AND fe.first_at < $2
    ${scopeWhere(opts.dealScope, opts.clientType)} ${deptWhere} ${pgWhere}
),
ev AS (
  SELECT de.deal_id, de.stage_id, de.event_at,
         LEAD(de.event_at) OVER (PARTITION BY de.deal_id ORDER BY de.event_at) AS next_at
  FROM deal_events de
  JOIN cohort c ON c.deal_id = de.deal_id
),
ev_work AS (
  SELECT ev.deal_id, ev.event_at, COALESCE(ev.next_at, now()) AS seg_end
  FROM ev
  JOIN time_stages ts ON ts.id = ev.stage_id
),
agg AS (
  SELECT deal_id,
    SUM(EXTRACT(EPOCH FROM seg_end - event_at)) / 86400.0 AS days,
    json_agg(json_build_object('a', EXTRACT(EPOCH FROM event_at), 'e', EXTRACT(EPOCH FROM seg_end)) ORDER BY event_at) AS segs
  FROM ev_work
  GROUP BY deal_id
)
SELECT
  c.deal_id AS deal_id,
  EXTRACT(EPOCH FROM c.reserved_at) AS reserved_at,
  EXTRACT(EPOCH FROM c.sold_at) AS sold_at,
  EXTRACT(EPOCH FROM c.delivered_at) AS delivered_at,
  COALESCE(a.days, 0) AS days,
  COALESCE(a.segs, '[]') AS segs
FROM cohort c
LEFT JOIN agg a ON a.deal_id = c.deal_id
  `.trim();

  interface Row {
    deal_id: number;
    reserved_at: string | null;
    sold_at: string | null;
    delivered_at: string | null;
    days: string;
    segs: { a: number; e: number }[];
  }
  const res = await analyticsDb().query<Row>(sql, params);

  // Для каждой сделки: сколько «реального рабочего времени» накопилось К
  // МОМЕНТУ T (T — reserved_at/sold_at/delivered_at секундами эпохи). Клипуем
  // сегменты по T — сегмент, который ЕЩЁ ИДЁТ на момент T, учитывается только
  // частично (t - a), сегменты, начавшиеся ПОСЛЕ T, не учитываются.
  function daysAt(segs: { a: number; e: number }[], t: number | null): number | null {
    if (t === null) return null;
    let sum = 0;
    for (const s of segs) {
      if (s.a >= t) break; // segs отсортированы по a — дальше только позже T
      sum += Math.max(0, Math.min(s.e, t) - s.a);
    }
    return Math.floor(sum / 86400);
  }

  return res.rows.map(r => {
    const segs = r.segs ?? [];
    return {
      dealId: Number(r.deal_id),
      observedDays: Math.floor(Number(r.days)),
      reservedDay: daysAt(segs, r.reserved_at === null ? null : Number(r.reserved_at)),
      soldDay: daysAt(segs, r.sold_at === null ? null : Number(r.sold_at)),
      shippedDay: daysAt(segs, r.delivered_at === null ? null : Number(r.delivered_at)),
    };
  });
}

function toRows(rows: MilestoneDealRow[], pick: 'reservedDay' | 'soldDay' | 'shippedDay'): LifeTableRow[] {
  return rows.map(r => ({ dealId: r.dealId, eventDay: r[pick], observedDays: r.observedDays }));
}

/** null — если весь период раньше старта сбора deal_events (03.04.2026). */
export async function fetchWorkExclReservedMilestoneCohort(opts: WorkExclReservedCohortOptions): Promise<MilestoneCohortResult | null> {
  const periodToStr = periodDateStrFromInstant(opts.period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const rows = await fetchMilestoneRows(opts);
  const reserved = buildLifeTablePoints(toRows(rows, 'reservedDay'));
  const sold = buildLifeTablePoints(toRows(rows, 'soldDay'));
  const shipped = buildLifeTablePoints(toRows(rows, 'shippedDay'));

  // cohort (points[i].cohort) идентична во всех трёх — observedDays общий,
  // отличается только eventDay. Берём из любой (reserved).
  const points: MilestoneCohortPoint[] = reserved.points.map((p, i) => ({
    day: p.day,
    label: p.label,
    cohort: p.cohort,
    reserved: p.sold,
    sold: sold.points[i].sold,
    shipped: shipped.points[i].sold,
  }));

  return {
    points,
    cohortTotal: reserved.cohortTotal,
    reservedTotal: reserved.soldTotal,
    soldTotal: sold.soldTotal,
    shippedTotal: shipped.soldTotal,
  };
}

// ── Дрилл-даун: список сделок одного дня одной из линий (или общей когорты) ─
export type MilestoneDrilldownKind = 'all' | 'reserved' | 'sold' | 'shipped';

export async function fetchWorkExclReservedMilestoneDealIds(
  opts: WorkExclReservedCohortOptions & { day: number; kind: MilestoneDrilldownKind },
): Promise<number[] | null> {
  const periodToStr = periodDateStrFromInstant(opts.period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  // Быстрый путь для kind='all' («дожили минимум N дней», самый частый клик —
  // столбик когорты гораздо выше линий-событий) — считаем через ДЕШЁВЫЙ
  // fetchWorkRows (обычный SUM-агрегат), а не через fetchMilestoneRows (тот же
  // SUM + json_agg сырых сегментов на каждую сделку когорты, нужен ТОЛЬКО для
  // вычисления дня конкретного милстоуна). На живых данных 30.07: 'all' через
  // fetchMilestoneRows — 9.7с на когорте ~36 тыс.; через fetchWorkRows — тот же
  // результат за ~2с (тот самый агрегат, что уже гоняют графики 2 и 4).
  if (opts.kind === 'all') {
    const workRows = await fetchWorkRows(opts, RESERVED_CONFIRMED_EVENT_TYPES);
    const ltRows: LifeTableRow[] = workRows.map(r => ({ dealId: r.dealId, eventDay: null, observedDays: Math.floor(r.days) }));
    return selectLifeTableDealIds(ltRows, opts.day, 'all');
  }

  // Здесь opts.kind ∈ {'reserved','sold','shipped'} ('all' обработан выше
  // быстрым путём) — точное попадание события на день N
  // (selectLifeTableDealIds filter='sold' семантика).
  const rows = await fetchMilestoneRows(opts);
  const pick = opts.kind === 'reserved' ? 'reservedDay' : opts.kind === 'shipped' ? 'shippedDay' : 'soldDay';
  const ltRows = toRows(rows, pick);
  return selectLifeTableDealIds(ltRows, opts.day, 'sold');
}
