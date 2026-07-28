import { analyticsDb } from '@/lib/db/clients';
import { toSqlInterval, periodDateStrFromInstant, type DateRange } from '@/lib/period';
import { DEAL_EVENTS_DATA_START } from './managerActivity';

// «CR Созвонился → Продажа» (задача владельца 28.07) — калька с
// priceObjectionConversion.ts (единственное отличие — набор стадий и исход только
// «Продажа»).
//
// «Созвонился» = стадии, чьё имя содержит «созвонился» (живая проверка 28.07 — 7
// стадий по воронкам 0/1/2/3: «Созвонился и озвучил цены (ЧЛ)», «Сделал запрос
// снабженцу, созвонился с заказчиком» ×4, «Созвонился и уточнил следующие
// материалы» ×2). «Не дозвонился» под ILIKE '%созвонился%' НЕ подпадает
// (д-озвонился ≠ с-озвонился) — доп. исключение не требуется. Резолвинг
// ДИНАМИЧЕСКИЙ по имени, не по хардкоду stage_id — новые одноимённые стадии
// подхватятся без миграции.
//
// Семантика — как у всей семьи «Конверсии стадий» (migrations/064): знаменатель =
// сделки, ВПЕРВЫЕ (MIN(event_at) по sa.deal_events) вошедшие в любую
// «созвонился»-стадию в периоде; числитель = те из них, что когда-либо ПОСЛЕ
// (sold_at >= момента входа) получили deals.sold_at. Перв./повт. — JOIN на
// funnels.is_repeat; атрибуция — deal_events.manager_id первого события.
export interface CalledConversionRow {
  denomPrimary: number;
  denomRepeat: number;
  numSalePrimary: number;
  numSaleRepeat: number;
}

export const CALLED_CONVERSION_HIDDEN_IDS = [
  'stage_called_denom_primary', 'stage_called_denom_repeat',
  'stage_called_to_sale_num_primary', 'stage_called_to_sale_num_repeat',
];

/** Возвращает null, если ВЕСЬ период раньше DEAL_EVENTS_DATA_START. */
export async function fetchCalledConversion(period: DateRange): Promise<Map<string, CalledConversionRow> | null> {
  const periodToStr = periodDateStrFromInstant(period.to, 'to');
  if (periodToStr < DEAL_EVENTS_DATA_START) return null;

  const { from, toExcl } = toSqlInterval(period);

  const sql = `
WITH called_stages AS (
  SELECT id FROM stages WHERE name ILIKE '%созвонился%'
),
first_entry AS (
  SELECT DISTINCT ON (de.deal_id)
    de.deal_id, de.event_at AS first_at, de.manager_id
  FROM deal_events de
  JOIN called_stages s ON s.id = de.stage_id
  ORDER BY de.deal_id, de.event_at ASC
),
cohort AS (
  SELECT * FROM first_entry
  WHERE first_at >= $1 AND first_at < $2
)
SELECT
  c.manager_id, c.first_at,
  d.sold_at,
  f.is_repeat
FROM cohort c
JOIN deals d ON d.deal_id = c.deal_id
JOIN funnels f ON f.id = d.funnel_id
  `.trim();

  const res = await analyticsDb().query<{
    manager_id: number; first_at: string;
    sold_at: string | null;
    is_repeat: boolean;
  }>(sql, [from, toExcl]);

  const map = new Map<string, CalledConversionRow>();
  for (const r of res.rows) {
    const managerId = String(r.manager_id);
    let row = map.get(managerId);
    if (!row) {
      row = { denomPrimary: 0, denomRepeat: 0, numSalePrimary: 0, numSaleRepeat: 0 };
      map.set(managerId, row);
    }

    if (r.is_repeat) row.denomRepeat += 1; else row.denomPrimary += 1;

    const firstAt = new Date(r.first_at).getTime();
    const soldAt = r.sold_at ? new Date(r.sold_at).getTime() : null;
    if (soldAt !== null && soldAt >= firstAt) {
      if (r.is_repeat) row.numSaleRepeat += 1; else row.numSalePrimary += 1;
    }
  }
  return map;
}
