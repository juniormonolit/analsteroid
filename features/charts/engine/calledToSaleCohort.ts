import { analyticsDb } from '@/lib/db/clients';
import { toSqlInterval, periodDateStrFromInstant, type DateRange } from '@/lib/period';
import { DEAL_EVENTS_DATA_START } from '@/features/reports/engine/managerActivity';
import { buildProductGroupFilter } from '@/features/reports/engine/productGroupFilter';
import { scopeWhere, departmentsWhere } from './stageSurvival';
import type { DealScope, ClientType, ProductGroupMode } from '@/lib/metrics/types';
import type { CalledToSaleCohortPoint, CalledToSaleCohortResult } from './types';

export type { CalledToSaleCohortPoint, CalledToSaleCohortResult } from './types';

// Когорта «Созвонился → продажа по дням» (задача владельца 2533, 29.07). Дословно
// владельца: «сколько всего было сделок в статусе "Созвонился..." и сколько их
// них всех в какой день по счету продается» — «100 сделок как минимум 0 дней и
// из них 15 продаж, как минимум 1 день и из них же 10 продаж...». Это таблица
// дожития (life table): день считается ОТ ВХОДА в стадию «Созвонился и озвучил
// цены» ДО ФАКТИЧЕСКОЙ ПРОДАЖИ (sold_at) — НЕ до выхода из стадии, это другая
// величина (см. features/charts/engine/stageSurvival.ts, пресет 'priced', там
// «дни» = до перехода в другую стадию). Когорта/резолвинг стадии — тот же паттерн
// (ILIKE по имени, MIN(event_at) по deal_events), максимально переиспользуем
// существующий движок: scopeWhere/departmentsWhere из stageSurvival.ts,
// buildProductGroupFilter, DEAL_EVENTS_DATA_START.
//
// Защита от известного бага (sold_at/lost_at пишутся один раз, не обновляются
// при повторном входе в стадию): продажа засчитывается только если
// sold_at >= first_at текущей когорты — тот же паттерн, что в stageSurvival.ts и
// calledConversion.ts. Полностью баг это не закрывает (повторная продажа в тот
// же цикл не различима), но это тот же остаточный риск, что уже принят
// владельцем в соседнем графике.

export interface CalledToSaleCohortOptions {
  period: DateRange;
  dealScope?: DealScope;
  clientType?: ClientType;
  departmentIds?: string[];
  productGroupMode?: ProductGroupMode;
  productGroupIds?: string[];
}

// Дни 0..30 поштучно, дальше — один агрегированный «хвост».
const MAX_DAY = 30;

interface DealRow {
  dealId: number;
  eventDay: number | null;   // floor(sold_at - first_at), null если не продана
  observedDays: number;      // eventDay если продана, иначе floor(now() - first_at)
}

async function fetchRows(opts: CalledToSaleCohortOptions): Promise<DealRow[]> {
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

  // Те же CTE target_stages/first_entry/cohort, что и fetchPricedRows в
  // stageSurvival.ts (когорта идентична — та же стадия, тот же период), но без
  // exit_event: тут нас интересует не выход из стадии, а sold_at относительно
  // first_at.
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
)
SELECT
  c.deal_id AS deal_id,
  CASE WHEN d.sold_at IS NOT NULL AND d.sold_at >= c.first_at
    THEN FLOOR(EXTRACT(EPOCH FROM d.sold_at - c.first_at) / 86400.0)
    ELSE NULL END AS event_day,
  CASE WHEN d.sold_at IS NOT NULL AND d.sold_at >= c.first_at
    THEN FLOOR(EXTRACT(EPOCH FROM d.sold_at - c.first_at) / 86400.0)
    ELSE FLOOR(EXTRACT(EPOCH FROM now() - c.first_at) / 86400.0) END AS observed_days
FROM cohort c
JOIN deals d ON d.deal_id = c.deal_id
JOIN funnels f ON f.id = d.funnel_id
WHERE 1=1 ${scopeWhere(opts.dealScope, opts.clientType)} ${deptWhere} ${pgWhere}
  `.trim();

  const res = await analyticsDb().query<{ deal_id: number; event_day: string | null; observed_days: string }>(sql, params);
  return res.rows.map(r => ({
    dealId: Number(r.deal_id),
    eventDay: r.event_day === null ? null : Number(r.event_day),
    observedDays: Number(r.observed_days),
  }));
}

/** null — если весь период раньше старта сбора deal_events (03.04.2026). */
export async function fetchCalledToSaleCohort(opts: CalledToSaleCohortOptions): Promise<CalledToSaleCohortResult | null> {
  const periodToStr = periodDateStrFromInstant(opts.period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const rows = await fetchRows(opts);

  const points: CalledToSaleCohortPoint[] = [
    ...Array.from({ length: MAX_DAY + 1 }, (_, day) => ({ day, label: String(day), cohort: 0, sold: 0, pct: null as number | null })),
    { day: MAX_DAY + 1, label: `${MAX_DAY + 1}+`, cohort: 0, sold: 0, pct: null },
  ];

  for (const r of rows) {
    // cohortAtLeastN: сколько сделок «дожили» минимум N дней, не продав раньше.
    // Право-цензурировано — сделка без продажи учитывается только пока
    // наблюдалась минимум N дней (observedDays>=N), иначе про её судьбу на день N
    // мы ещё ничего не знаем.
    for (let day = 0; day <= MAX_DAY; day++) {
      if (r.observedDays >= day) points[day].cohort += 1;
    }
    if (r.observedDays >= MAX_DAY + 1) points[MAX_DAY + 1].cohort += 1;

    if (r.eventDay !== null) {
      const idx = r.eventDay <= MAX_DAY ? r.eventDay : MAX_DAY + 1;
      points[idx].sold += 1;
    }
  }

  for (const p of points) {
    p.pct = p.cohort > 0 ? Math.round((p.sold / p.cohort) * 1000) / 10 : null;
  }

  const soldTotal = points.reduce((s, p) => s + p.sold, 0);
  const cohortTotal = points[0]?.cohort ?? 0;

  return {
    points,
    cohortTotal,
    soldTotal,
    overallPct: cohortTotal > 0 ? Math.round((soldTotal / cohortTotal) * 1000) / 10 : null,
  };
}

// ── Дрилл-даун: список сделок одного дня (задача 2546, владелец 29.07) ──────
// Тот же выбор, что делает fetchCalledToSaleCohort при агрегации в points[day] —
// повторяем условия 1-в-1, чтобы число сделок в списке совпадало с числом на
// графике:
//  * filter='all'  → «дожили» минимум day дней (observedDays >= day), при
//    day===MAX_DAY+1 это отдельное условие «31+», как в основном цикле.
//  * filter='sold' → продали РОВНО на день day (eventDay===day для day<=MAX_DAY;
//    для day===MAX_DAY+1 — eventDay > MAX_DAY, тот же idx-маппинг «31+»).
export async function fetchCalledToSaleCohortDealIds(
  opts: CalledToSaleCohortOptions & { day: number; filter: 'all' | 'sold' },
): Promise<number[] | null> {
  const periodToStr = periodDateStrFromInstant(opts.period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const day = opts.day;
  if (day < 0 || day > MAX_DAY + 1) return [];

  const rows = await fetchRows(opts);

  if (opts.filter === 'sold') {
    return rows
      .filter(r => r.eventDay !== null && (day <= MAX_DAY ? r.eventDay === day : r.eventDay > MAX_DAY))
      .map(r => r.dealId);
  }
  // filter === 'all' — та же «at risk» логика, что в основном цикле выше.
  return rows.filter(r => r.observedDays >= day).map(r => r.dealId);
}
