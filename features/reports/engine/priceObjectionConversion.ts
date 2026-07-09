import { analyticsDb } from '@/lib/db/clients';
import { toSqlInterval, type DateRange } from '@/lib/period';
import { DEAL_EVENTS_DATA_START } from './managerActivity';

// CR «Есть цена дешевле» → Бронь/Продажа/Отказ (задача 1, owners-inbox, 10.07).
//
// Стадия резолвится ДИНАМИЧЕСКИ по названию (ILIKE 'Есть цена дешевле%'), НЕ по
// хардкоду stage_id — объединяет одноимённые стадии across воронок (живая проверка
// 10.07: сейчас это UC_PU4HM2 (ЧЛ) и C1:11 (ЮЛ), обе is_repeat=false;
// owners-inbox/stage-marking-price-speed.md упоминал ещё C2:4/C3:4 в повторных
// воронках B2C/B2B — на момент проверки такие стадии в sa.stages не найдены).
// Благодаря динамическому резолвингу и НАСТОЯЩЕМУ join на funnels.is_repeat (а не
// хардкоду «всегда primary») — если Bitrix позже заведёт такую стадию в B2C/B2B,
// «(повт.)»/«(все)» начнут получать реальные числа без новой миграции.
//
// Семантика — как и в stageConversions.ts: знаменатель = сделки, ВПЕРВЫЕ (MIN
// (event_at), sa.deal_events) попавшие в стадию в периоде отчёта; числитель = те из
// них, что когда-либо ПОСЛЕ этого (>= момента попадания, не только «в периоде»)
// получили deals.reserved_at (Бронь) / deals.sold_at (Продажа) / deals.lost_at
// (Отказ) — исходы берутся с deals-колонок (не deal_events), как явно указано в
// задаче.
export interface PriceObjectionRow {
  denomPrimary: number;
  denomRepeat: number;
  numReservationPrimary: number;
  numReservationRepeat: number;
  numSalePrimary: number;
  numSaleRepeat: number;
  numLostPrimary: number;
  numLostRepeat: number;
}

/**
 * Один агрегатный SQL: CTE `first_entry` — DISTINCT ON (deal_id) по стадиям,
 * подходящим под ILIKE, с MIN(event_at) через ORDER BY (тот же приём, что и в
 * stageConversions.ts/managerActivity.ts). Атрибуция манагера — deal_events.manager_id
 * этого конкретного (первого) события. is_repeat — JOIN на funnels через deals.funnel_id
 * (реальный запрос, не предположение).
 *
 * Возвращает null, если ВЕСЬ период раньше DEAL_EVENTS_DATA_START.
 */
export async function fetchPriceObjectionConversion(period: DateRange): Promise<Map<string, PriceObjectionRow> | null> {
  const periodToStr = period.to.toISOString().slice(0, 10);
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const { from, toExcl } = toSqlInterval(period);

  const sql = `
WITH price_lower_stages AS (
  SELECT id FROM stages WHERE name ILIKE 'Есть цена дешевле%'
),
first_entry AS (
  SELECT DISTINCT ON (de.deal_id)
    de.deal_id, de.event_at AS first_at, de.manager_id
  FROM deal_events de
  JOIN price_lower_stages s ON s.id = de.stage_id
  ORDER BY de.deal_id, de.event_at ASC
),
cohort AS (
  SELECT * FROM first_entry
  WHERE first_at >= $1 AND first_at < $2
)
SELECT
  c.manager_id, c.first_at,
  d.reserved_at, d.sold_at, d.lost_at,
  f.is_repeat
FROM cohort c
JOIN deals d ON d.deal_id = c.deal_id
JOIN funnels f ON f.id = d.funnel_id
  `.trim();

  const res = await analyticsDb().query<{
    manager_id: number; first_at: string;
    reserved_at: string | null; sold_at: string | null; lost_at: string | null;
    is_repeat: boolean;
  }>(sql, [from, toExcl]);

  const map = new Map<string, PriceObjectionRow>();
  const ensure = (managerId: string): PriceObjectionRow => {
    let row = map.get(managerId);
    if (!row) {
      row = {
        denomPrimary: 0, denomRepeat: 0,
        numReservationPrimary: 0, numReservationRepeat: 0,
        numSalePrimary: 0, numSaleRepeat: 0,
        numLostPrimary: 0, numLostRepeat: 0,
      };
      map.set(managerId, row);
    }
    return row;
  };

  for (const r of res.rows) {
    const managerId = String(r.manager_id);
    const row = ensure(managerId);
    const firstAt = new Date(r.first_at).getTime();
    const isRepeat = r.is_repeat;

    if (isRepeat) row.denomRepeat += 1; else row.denomPrimary += 1;

    const reservedAt = r.reserved_at ? new Date(r.reserved_at).getTime() : null;
    const soldAt = r.sold_at ? new Date(r.sold_at).getTime() : null;
    const lostAt = r.lost_at ? new Date(r.lost_at).getTime() : null;

    if (reservedAt !== null && reservedAt >= firstAt) {
      if (isRepeat) row.numReservationRepeat += 1; else row.numReservationPrimary += 1;
    }
    if (soldAt !== null && soldAt >= firstAt) {
      if (isRepeat) row.numSaleRepeat += 1; else row.numSalePrimary += 1;
    }
    if (lostAt !== null && lostAt >= firstAt) {
      if (isRepeat) row.numLostRepeat += 1; else row.numLostPrimary += 1;
    }
  }

  return map;
}
