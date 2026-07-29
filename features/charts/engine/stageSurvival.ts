import { analyticsDb } from '@/lib/db/clients';
import { toSqlInterval, periodDateStrFromInstant, type DateRange } from '@/lib/period';
import { DEAL_EVENTS_DATA_START } from '@/features/reports/engine/managerActivity';
import { buildProductGroupFilter } from '@/features/reports/engine/productGroupFilter';
import type { DealScope, ClientType, ProductGroupMode } from '@/lib/metrics/types';

// Кривая «вероятность продажи от числа дней в стадии» (задача владельца 28.07,
// раздел «Графики»): когорта = сделки, ВПЕРВЫЕ вошедшие в целевой набор стадий в
// периоде (та же семантика MIN(event_at), что у «Конверсий стадий»); для каждой
// сделки считаем, сколько дней она провела в наборе, раскладываем по корзинам
// дней и в каждой корзине смотрим долю сделок, дошедших до sold_at. Это НЕ метрика
// каталога — отдельный движок поверх sa.deal_events (владелец: «таких метрик у нас
// нет, можно и нужно ввести, но это не срочно»).
//
// Два пресета:
//  * 'priced' — стадия «Созвонился и озвучил цены» (резолвится ILIKE по имени, как
//    в calledConversion.ts; сейчас это только ЧЛ). Дни = от первого входа до
//    ПЕРВОГО события вне набора (выход); если сделка ещё в стадии — до текущего
//    момента.
//  * 'work' — все стадии с sa.stages.stage_type='WORK' (разметка портала). Дни =
//    СУММА интервалов «событие WORK-стадии → следующее событие» по всей истории
//    сделки (хвост открытой WORK-стадии — до текущего момента).
import type { SurvivalPreset, SurvivalBucket, SurvivalResult } from './types';

export type { SurvivalPreset, SurvivalBucket, SurvivalResult } from './types';

export interface SurvivalOptions {
  preset: SurvivalPreset;
  period: DateRange;
  dealScope?: DealScope;    // default 'all' на уровне движка; UI шлёт 'primary'
  clientType?: ClientType;
  departmentIds?: string[];
  // Фильтр товарных групп (задача 29.07): мультиселект + шкала. Пустой/undefined
  // productGroupIds = все группы (текущее поведение, без регрессии).
  productGroupMode?: ProductGroupMode;
  productGroupIds?: string[];
}

// Корзины дней: 0..13 по дню, дальше огрубляем — хвост тонкий, по дню он шумит.
const BUCKETS: Array<{ label: string; from: number; toExcl: number }> = [
  ...Array.from({ length: 14 }, (_, i) => ({ label: String(i), from: i, toExcl: i + 1 })),
  { label: '14–20', from: 14, toExcl: 21 },
  { label: '21–30', from: 21, toExcl: 31 },
  { label: '30+', from: 31, toExcl: Infinity },
];

// Экспортированы для повторного использования в calledToSaleCohort.ts (когорта
// «Созвонился → продажа по дням», задача 2533) — те же фильтры воронки/отдела,
// один источник правды вместо копипасты.
export function scopeWhere(dealScope: DealScope | undefined, clientType: ClientType | undefined): string {
  const parts: string[] = [];
  if (dealScope === 'primary') parts.push('f.is_repeat = false');
  if (dealScope === 'repeat') parts.push('f.is_repeat = true');
  if (clientType === 'b2c') parts.push('d.funnel_id IN (0, 2)');
  if (clientType === 'b2b') parts.push('d.funnel_id IN (1, 3)');
  return parts.length ? `AND ${parts.join(' AND ')}` : '';
}

// Фильтр отделов — тот же подзапрос, что в byManagers (sa.org_resolved_hierarchy,
// живая оргструктура из синка Битрикса, НЕ протухшая YC-копия — #2065).
export function departmentsWhere(paramIdx: number): string {
  // manager_bitrix_user_id — text, current_manager_id — integer: без ::text Postgres 42883
  return `AND d.current_manager_id::text IN (
    SELECT orh.manager_bitrix_user_id FROM sa.org_resolved_hierarchy orh
    WHERE orh.department_id IN (SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($${paramIdx}))
      AND orh.is_active = true
  )`;
}

// Резолвинг стадии «Созвонился и озвучил цены» по имени (ILIKE, только ЧЛ) —
// один паттерн на весь модуль + calledToSaleCohort.ts.
export const CALLED_PRICED_STAGE_ILIKE = 'Созвонился и озвучил%';

interface DealRow { days: number; sold: boolean; open: boolean }

async function fetchPricedRows(opts: SurvivalOptions): Promise<DealRow[]> {
  const { from, toExcl } = toSqlInterval(opts.period);
  const params: unknown[] = [from, toExcl];
  let deptWhere = '';
  if (opts.departmentIds?.length) {
    params.push(opts.departmentIds);
    deptWhere = departmentsWhere(params.length);
  }
  // Фильтр товарных групп (задача 29.07) — параметризованный, offset = уже
  // занятые позиции params на этот момент.
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
WITH target_stages AS (
  SELECT id FROM stages WHERE name ILIKE 'Созвонился и озвучил%'
),
first_entry AS (
  SELECT DISTINCT ON (de.deal_id) de.deal_id, de.event_at AS first_at
  FROM deal_events de
  JOIN target_stages s ON s.id = de.stage_id
  ORDER BY de.deal_id, de.event_at ASC
),
cohort AS (
  SELECT * FROM first_entry WHERE first_at >= $1 AND first_at < $2
),
exit_event AS (
  SELECT c.deal_id, MIN(de.event_at) AS exit_at
  FROM cohort c
  JOIN deal_events de ON de.deal_id = c.deal_id AND de.event_at > c.first_at
  WHERE de.stage_id NOT IN (SELECT id FROM target_stages)
  GROUP BY c.deal_id
)
SELECT
  EXTRACT(EPOCH FROM COALESCE(e.exit_at, now()) - c.first_at) / 86400.0 AS days,
  (d.sold_at IS NOT NULL AND d.sold_at >= c.first_at) AS sold,
  (e.exit_at IS NULL) AS open
FROM cohort c
JOIN deals d ON d.deal_id = c.deal_id
JOIN funnels f ON f.id = d.funnel_id
LEFT JOIN exit_event e ON e.deal_id = c.deal_id
WHERE 1=1 ${scopeWhere(opts.dealScope, opts.clientType)} ${deptWhere} ${pgWhere}
  `.trim();

  const res = await analyticsDb().query<{ days: string; sold: boolean; open: boolean }>(sql, params);
  return res.rows.map(r => ({ days: Number(r.days), sold: r.sold, open: r.open }));
}

async function fetchWorkRows(opts: SurvivalOptions): Promise<DealRow[]> {
  const { from, toExcl } = toSqlInterval(opts.period);
  const params: unknown[] = [from, toExcl];
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

  // event_type IN ('sold','shipped') исключены, хотя их stage_type тоже 'WORK'
  // («Продано (ЧЛ)», «Заказ в работе, счет оплачен», «Отгружено»…): проданная сделка
  // копила бы «дни в работе» бесконечно, и кривая мерила бы не «сколько работали до
  // исхода», а «проданные висят в Продано» (артефакт виден на живых данных 28.07 —
  // кривая РОСЛА с днями). Считаем время в работе ДО продажи/отгрузки.
  const sql = `
WITH work_stages AS (
  SELECT id FROM stages WHERE stage_type = 'WORK' AND event_type NOT IN ('sold', 'shipped')
),
first_entry AS (
  SELECT DISTINCT ON (de.deal_id) de.deal_id, de.event_at AS first_at
  FROM deal_events de
  JOIN work_stages s ON s.id = de.stage_id
  ORDER BY de.deal_id, de.event_at ASC
),
cohort AS (
  SELECT * FROM first_entry WHERE first_at >= $1 AND first_at < $2
),
ev AS (
  SELECT de.deal_id, de.stage_id, de.event_at,
         LEAD(de.event_at) OVER (PARTITION BY de.deal_id ORDER BY de.event_at) AS next_at
  FROM deal_events de
  JOIN cohort c ON c.deal_id = de.deal_id
),
work_time AS (
  SELECT ev.deal_id,
         SUM(EXTRACT(EPOCH FROM COALESCE(ev.next_at, now()) - ev.event_at)) / 86400.0 AS days,
         BOOL_OR(ev.next_at IS NULL) AS open
  FROM ev
  JOIN work_stages ws ON ws.id = ev.stage_id
  GROUP BY ev.deal_id
)
SELECT
  w.days,
  (d.sold_at IS NOT NULL AND d.sold_at >= c.first_at) AS sold,
  w.open
FROM cohort c
JOIN work_time w ON w.deal_id = c.deal_id
JOIN deals d ON d.deal_id = c.deal_id
JOIN funnels f ON f.id = d.funnel_id
WHERE 1=1 ${scopeWhere(opts.dealScope, opts.clientType)} ${deptWhere} ${pgWhere}
  `.trim();

  const res = await analyticsDb().query<{ days: string; sold: boolean; open: boolean }>(sql, params);
  return res.rows.map(r => ({ days: Number(r.days), sold: r.sold, open: r.open }));
}

/** null — если весь период раньше старта сбора deal_events (03.04.2026). */
export async function fetchStageSurvival(opts: SurvivalOptions): Promise<SurvivalResult | null> {
  const periodToStr = periodDateStrFromInstant(opts.period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const rows = opts.preset === 'work' ? await fetchWorkRows(opts) : await fetchPricedRows(opts);

  const buckets: SurvivalBucket[] = BUCKETS.map(b => ({
    label: b.label, daysFrom: b.from, total: 0, sold: 0, pct: null,
  }));
  let soldTotal = 0;
  let stillInStage = 0;
  for (const r of rows) {
    const idx = BUCKETS.findIndex(b => r.days >= b.from && r.days < b.toExcl);
    const b = buckets[idx === -1 ? buckets.length - 1 : idx];
    b.total += 1;
    if (r.sold) { b.sold += 1; soldTotal += 1; }
    if (r.open) stillInStage += 1;
  }
  for (const b of buckets) {
    b.pct = b.total > 0 ? Math.round((b.sold / b.total) * 1000) / 10 : null;
  }

  return {
    buckets,
    cohortTotal: rows.length,
    soldTotal,
    overallPct: rows.length > 0 ? Math.round((soldTotal / rows.length) * 1000) / 10 : null,
    stillInStage,
  };
}
