import { analyticsDb } from '@/lib/db/clients';
import { toSqlInterval, periodDateStrFromInstant, type DateRange } from '@/lib/period';
import { DEAL_EVENTS_DATA_START } from './managerActivity';

// Матрица CR по основному пути ЧЛ+ЮЛ (задача 2, owners-inbox, 10.07): «Новая →
// Взял в работу → Связался со снабженцем → Озвучил цену/КП → Бронь → Подтв. бронь →
// Продажа → Отгрузка» + «X → Отказ» из каждого промежуточного шага.
//
// Единый механизм (см. комментарий в migrations/064): знаменатель = сделки, ВПЕРВЫЕ
// (MIN(event_at) по sa.deal_events) попавшие в группу стадий X в периоде отчёта;
// числитель = те из них, что когда-либо ПОСЛЕ этого (не только в периоде) впервые
// попали в группу Y, либо (для «Отказ») получили deals.lost_at.
//
// Stage ID НЕ параллельны между воронками ЧЛ/ЮЛ (Bitrix: каждый пайплайн — свой
// набор ID) — группы собраны по факту реального справочника стадий (живая проверка
// 10.07, sa.stages funnel_id IN (0,1)), не по предположению.
export const STAGE_GROUPS: Record<string, string[]> = {
  new: ['NEW', 'C1:NEW'],
  taken: ['PREPARATION', 'PREPAYMENT_INVOICE', 'C1:PREPARATION', 'C1:PREPAYMENT_INVOICE'],
  contacted: ['EXECUTING', 'C1:EXECUTING'],
  priced: ['FINAL_INVOICE', 'C1:FINAL_INVOICE'],
  reservation: ['UC_SQEHTU', 'C1:1'],
  confirmed: ['1', 'C1:2'],
  sale: ['2', 'C1:3'],
  shipped: ['WON', 'C1:WON'],
};

export interface StagePairDef {
  from: keyof typeof STAGE_GROUPS;
  to: keyof typeof STAGE_GROUPS | 'lost';
  id: string; // suffix used in catalog ids stage_<id>_num / cr_stage_<id>[...]
}

// 14 пар: 7 «следующий шаг» + 7 «X → Отказ» (без «Отгрузка → Отказ» — терминальный
// успех, штрафные возвраты сюда сознательно не считаем, вне рамок задачи).
export const STAGE_PAIRS: StagePairDef[] = [
  { from: 'new', to: 'taken', id: 'new_to_taken' },
  { from: 'new', to: 'lost', id: 'new_to_lost' },
  { from: 'taken', to: 'contacted', id: 'taken_to_contacted' },
  { from: 'taken', to: 'lost', id: 'taken_to_lost' },
  { from: 'contacted', to: 'priced', id: 'contacted_to_priced' },
  { from: 'contacted', to: 'lost', id: 'contacted_to_lost' },
  { from: 'priced', to: 'reservation', id: 'priced_to_reservation' },
  { from: 'priced', to: 'lost', id: 'priced_to_lost' },
  { from: 'reservation', to: 'confirmed', id: 'reservation_to_confirmed' },
  { from: 'reservation', to: 'lost', id: 'reservation_to_lost' },
  { from: 'confirmed', to: 'sale', id: 'confirmed_to_sale' },
  { from: 'confirmed', to: 'lost', id: 'confirmed_to_lost' },
  { from: 'sale', to: 'shipped', id: 'sale_to_shipment' },
  { from: 'sale', to: 'lost', id: 'sale_to_lost' },
];

const FROM_GROUPS = [...new Set(STAGE_PAIRS.map(p => p.from))];

export interface StageConversionRow {
  denom: Record<string, number>; // group -> count
  num: Record<string, number>; // pair.id -> count
}

/**
 * ДВА агрегатных SQL-запроса (без N+1), джойн между стадиями — в JS, не в БД.
 *
 * Изначальная версия (один SQL: CTE first_entry + 7 LEFT JOIN на саму себя по
 * (deal_id, group_name) — по одному на каждую «to»-группу) живьём на проде давала
 * ПАТОЛОГИЧЕСКИЙ план: EXPLAIN ANALYZE не завершился за 150с даже с `AS MATERIALIZED`
 * (сама first_entry — 76k строк, 662-930мс отдельно; с деревом из 7 LEFT JOIN на неё
 * же — planner уходит в nested loop вместо hash join). Живая проверка 10.07: разбивка
 * на 2 простых запроса + join в памяти — 1.4с суммарно на полном периоде (03.04-
 * 09.07, 76k строк first_entry + ~33k строк deals). Числа сверены независимым ручным
 * SQL (confirmed→sale: denom=2008, num=1142 — совпало точь-в-точь).
 *
 * Запрос 1 — ВСЕ first-entry по ВСЕМ 8 группам разом (без периода, без self-join):
 *   DISTINCT ON (group_name, deal_id) + ORDER BY event_at ASC = MIN(event_at) на
 *   группу+сделку, атрибуция манагера — deal_events.manager_id ЭТОГО (первого)
 *   события (тот же приём, что managerActivity.ts — домен ID совпадает с
 *   current_manager_id, единичные «сироты» статистически незначимы).
 * Запрос 2 — deals.lost_at ТОЛЬКО для затронутых deal_id (исход «Отказ»,
 *   универсален для любого шага пути).
 * Периодный фильтр (когорта = знаменатель) и «когда-либо ПОСЛЕ» (числитель, БЕЗ
 * ограничения периодом) — оба применяются в JS по уже загруженным Map'ам.
 *
 * Возвращает null, если ВЕСЬ период раньше DEAL_EVENTS_DATA_START (честный null,
 * как и в managerActivity.ts).
 */
export async function fetchStageConversions(period: DateRange): Promise<Map<string, StageConversionRow> | null> {
  // periodDateStrFromInstant — тот же UTC-сдвиг, что чинили в план-метриках (8a4ab37,
  // задача 1595) и managerActivity.ts (задача 1610).
  const periodToStr = periodDateStrFromInstant(period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const { from, toExcl } = toSqlInterval(period);
  const fromMs = new Date(from).getTime();
  const toMs = new Date(toExcl).getTime();

  const groupValuesRows = Object.entries(STAGE_GROUPS).flatMap(([g, ids]) =>
    ids.map(id => `('${g}', '${id.replace(/'/g, "''")}')`),
  );
  const groupValues = groupValuesRows.join(',\n    ');

  const feRes = await analyticsDb().query<{
    group_name: string; deal_id: number; first_at: string; manager_id: number;
  }>(`
WITH groups(group_name, stage_id) AS (
  VALUES
    ${groupValues}
)
SELECT DISTINCT ON (g.group_name, de.deal_id)
  g.group_name AS group_name, de.deal_id AS deal_id, de.event_at AS first_at, de.manager_id AS manager_id
FROM deal_events de
JOIN groups g ON g.stage_id = de.stage_id
ORDER BY g.group_name, de.deal_id, de.event_at ASC
  `.trim());

  // entriesByDeal: deal_id -> (group_name -> {firstAt, managerId})
  const entriesByDeal = new Map<number, Map<string, { firstAt: number; managerId: number }>>();
  for (const r of feRes.rows) {
    let m = entriesByDeal.get(r.deal_id);
    if (!m) { m = new Map(); entriesByDeal.set(r.deal_id, m); }
    m.set(r.group_name, { firstAt: new Date(r.first_at).getTime(), managerId: r.manager_id });
  }

  const dealIds = [...entriesByDeal.keys()];
  const lostRes = dealIds.length
    ? await analyticsDb().query<{ deal_id: number; lost_at: string | null }>(
        'SELECT deal_id, lost_at FROM deals WHERE deal_id = ANY($1::int[])',
        [dealIds],
      )
    : { rows: [] as Array<{ deal_id: number; lost_at: string | null }> };
  const lostAtByDeal = new Map(lostRes.rows.map(r => [r.deal_id, r.lost_at ? new Date(r.lost_at).getTime() : null]));

  const map = new Map<string, StageConversionRow>();
  const ensure = (managerId: string): StageConversionRow => {
    let row = map.get(managerId);
    if (!row) {
      row = { denom: {}, num: {} };
      map.set(managerId, row);
    }
    return row;
  };

  for (const [dealId, groupsMap] of entriesByDeal) {
    for (const fromGroup of FROM_GROUPS) {
      const entry = groupsMap.get(fromGroup);
      if (!entry) continue;
      if (entry.firstAt < fromMs || entry.firstAt >= toMs) continue; // не в когорте периода
      const row = ensure(String(entry.managerId));
      row.denom[fromGroup] = (row.denom[fromGroup] ?? 0) + 1;

      for (const pair of STAGE_PAIRS) {
        if (pair.from !== fromGroup) continue;
        let reached: boolean;
        if (pair.to === 'lost') {
          const lostAt = lostAtByDeal.get(dealId) ?? null;
          reached = lostAt !== null && lostAt >= entry.firstAt;
        } else {
          const toEntry = groupsMap.get(pair.to);
          reached = !!toEntry && toEntry.firstAt >= entry.firstAt;
        }
        if (reached) row.num[pair.id] = (row.num[pair.id] ?? 0) + 1;
      }
    }
  }

  return map;
}

// ── График CR стадий по времени (правка владельца 27.08: «по относительным
// метрикам графики не строятся, можем сделать?») ─────────────────────────────
// Семейство cr_stage_* — ~70 видимых метрик, крупнейшая группа без графика.
// Универсальная разбивка им не подходит (числители из deal_events со своей
// логикой «впервые вошёл в группу стадий»), но цикл выше и так перебирает
// сделки поштучно с датой первого входа на руках — бакетим по ней, тем же
// приёмом, что fetchBookingCallRateSeries.
//
// Семантика точки: «из сделок, впервые вошедших в стадию X в этот день/неделю/
// месяц, N% дошли (когда-либо после) до Y» — когортная, как ячейка отчёта;
// сумма num/denom бакетов сходится с ячейкой.

import { bucketStartYmd, nextBucketYmd, type SeriesGranularity, type MetricSeriesResult, type SeriesBucket } from './metricSeries';

/** cr_stage_<pair>[_all|_repeat] → пара матрицы; null = не наша метрика. */
export function stagePairForMetric(metricId: string): StagePairDef | null {
  const m = /^cr_stage_(.+?)(?:_all|_repeat)?$/.exec(metricId);
  if (!m) return null;
  return STAGE_PAIRS.find(p => p.id === m[1]) ?? null;
}

export async function fetchStageConversionSeries(opts: {
  metricId: string;
  period: DateRange;
  granularity: SeriesGranularity;
  managerIds?: string[];
  departmentIds?: string[];
}): Promise<MetricSeriesResult> {
  const pair = stagePairForMetric(opts.metricId);
  if (!pair) return { supported: false, reason: 'Не метрика CR стадий', buckets: [], cumulativeBuckets: [], total: null };

  const periodToStr = periodDateStrFromInstant(opts.period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) {
    return { supported: false, reason: `События стадий собираются с ${DEAL_EVENTS_DATA_START} — весь период раньше`, buckets: [], cumulativeBuckets: [], total: null };
  }

  // Ограничение менеджерами: явный список от клиента ∩ менеджеры выбранных
  // отделов (оргструктура из sa — задача 2065, тот же запрос, что byProductGroups).
  let mgrSet: Set<string> | null = opts.managerIds?.length ? new Set(opts.managerIds) : null;
  const deptIds = (opts.departmentIds ?? []).filter(Boolean);
  if (deptIds.length > 0) {
    const res = await analyticsDb().query<{ id: string }>(
      `SELECT DISTINCT manager_bitrix_user_id::text AS id
         FROM sa.org_resolved_hierarchy
        WHERE department_id IN (SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($1))
          AND is_active = true`,
      [deptIds],
    );
    const dept = new Set(res.rows.map(r => r.id));
    mgrSet = mgrSet ? new Set([...mgrSet].filter(v => dept.has(v))) : dept;
  }

  const { from, toExcl } = toSqlInterval(opts.period);
  const fromMs = new Date(from).getTime();
  const toMs = new Date(toExcl).getTime();

  // Первые входы в ДВЕ нужные группы (или одну + lost_at) — не во все 8, как в
  // матрице: серия строится по одной паре, тянуть остальное незачем.
  const groups = [pair.from, ...(pair.to === 'lost' ? [] : [pair.to])] as (keyof typeof STAGE_GROUPS)[];
  const groupValues = groups.flatMap(g => STAGE_GROUPS[g].map(id => `('${g}', '${id.replace(/'/g, "''")}')`)).join(',\n    ');
  const feRes = await analyticsDb().query<{ group_name: string; deal_id: number; first_at: string; manager_id: number }>(`
WITH groups(group_name, stage_id) AS (
  VALUES
    ${groupValues}
)
SELECT DISTINCT ON (g.group_name, de.deal_id)
  g.group_name, de.deal_id, de.event_at AS first_at, de.manager_id
FROM deal_events de
JOIN groups g ON g.stage_id = de.stage_id
ORDER BY g.group_name, de.deal_id, de.event_at ASC
  `.trim());

  const fromByDeal = new Map<number, { at: number; mgr: string }>();
  const toByDeal = new Map<number, number>();
  for (const r of feRes.rows) {
    const at = new Date(r.first_at).getTime();
    if (r.group_name === pair.from) fromByDeal.set(r.deal_id, { at, mgr: String(r.manager_id) });
    else toByDeal.set(r.deal_id, at);
  }

  // Когорта: первый вход в X внутри периода (+ фильтр по менеджерам).
  const cohort = [...fromByDeal.entries()].filter(([, e]) =>
    e.at >= fromMs && e.at < toMs && (!mgrSet || mgrSet.has(e.mgr)));

  let lostAtByDeal = new Map<number, number | null>();
  if (pair.to === 'lost' && cohort.length > 0) {
    const res = await analyticsDb().query<{ deal_id: number; lost_at: string | null }>(
      'SELECT deal_id, lost_at FROM deals WHERE deal_id = ANY($1::int[])',
      [cohort.map(([id]) => id)],
    );
    lostAtByDeal = new Map(res.rows.map(r => [r.deal_id, r.lost_at ? new Date(r.lost_at).getTime() : null]));
  }

  const agg = new Map<string, { num: number; denom: number }>();
  let totNum = 0, totDenom = 0;
  for (const [dealId, e] of cohort) {
    const b = bucketStartYmd(new Date(e.at), opts.granularity);
    let a = agg.get(b);
    if (!a) { a = { num: 0, denom: 0 }; agg.set(b, a); }
    a.denom++; totDenom++;
    let reached: boolean;
    if (pair.to === 'lost') {
      const lostAt = lostAtByDeal.get(dealId) ?? null;
      reached = lostAt !== null && lostAt >= e.at;
    } else {
      const toAt = toByDeal.get(dealId);
      reached = toAt !== undefined && toAt >= e.at;
    }
    if (reached) { a.num++; totNum++; }
  }

  const startYmd = bucketStartYmd(opts.period.from, opts.granularity);
  const endExcl = new Date(`${periodToStr}T00:00:00+03:00`);
  endExcl.setUTCDate(endExcl.getUTCDate() + 1);
  const endExclYmd = bucketStartYmd(endExcl, 'day');
  const buckets: SeriesBucket[] = [];
  const cumulativeBuckets: SeriesBucket[] = [];
  let cumNum = 0, cumDenom = 0;
  for (let b = startYmd; b < endExclYmd && buckets.length < 500; b = nextBucketYmd(b, opts.granularity)) {
    const a = agg.get(b);
    const beforeData = nextBucketYmd(b, opts.granularity) <= DEAL_EVENTS_DATA_START;
    buckets.push({ bucket: b, value: !beforeData && a && a.denom > 0 ? (a.num / a.denom) * 100 : null });
    if (!beforeData && a) { cumNum += a.num; cumDenom += a.denom; }
    cumulativeBuckets.push({ bucket: b, value: cumDenom > 0 ? (cumNum / cumDenom) * 100 : null });
  }

  return { supported: true, buckets, cumulativeBuckets, total: totDenom > 0 ? (totNum / totDenom) * 100 : null };
}
