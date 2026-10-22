// Фильтр «Товарная группа: отгружали когда-либо за период» (владелец 22.10, правка №5: «товарная
// группа отгрузки „когда-либо по истории“ за период, который мы выбираем» — на всю доску).
// Группа отгрузки = head-группа сделки ИЛИ любого товара в ней (газобетон в сделке «Кровля» тоже
// газобетон), услуги/доставка/«Разное» — не группы (та же выборка, что у кросс-селла).
// Ключ — сырой client_key сделки; склейку заказчиков сворачивает board.ts по memberKeys.
// ~22 тыс. заказчиков за всю историю — ~1,2 с, поэтому кэш в памяти процесса на 10 минут.
import { analyticsDb } from '@/lib/db/clients';
import { CLIENT_KEY_CASE_SQL } from '@/features/customers/engine/clientKey';
import { GROUP_PERIODS } from './config';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const mskToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const addDays = (ymd: string, d: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

/** Период → [from, toExclusive) по датам МСК. Пустые/кривые свои даты — открытая граница. */
export function resolvePeriod(period: string | null, from: string | null, to: string | null): { from: string; to: string } {
  const today = mskToday();
  const p = GROUP_PERIODS.find(x => x.value === period) ?? GROUP_PERIODS.find(x => x.value === '1y')!;
  if (p.value === 'custom') {
    return { from: from && YMD.test(from) ? from : '2000-01-01', to: to && YMD.test(to) ? addDays(to, 1) : addDays(today, 1) };
  }
  if (p.months === null) return { from: '2000-01-01', to: addDays(today, 1) };
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - p.months);
  return { from: d.toISOString().slice(0, 10), to: addDays(today, 1) };
}

const cache = new Map<string, { at: number; map: Map<string, string[]> }>();
const TTL = 10 * 60_000;

/** Заказчик (сырой ключ) → товарные группы, отгруженные в [from, to). */
export async function fetchShippedGroups(from: string, to: string): Promise<Map<string, string[]>> {
  const key = `${from}|${to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.map;
  const r = await analyticsDb().query<{ client_key: string; groups: string[] }>(
    `SELECT client_key, array_agg(DISTINCT g) AS groups FROM (
       SELECT (${CLIENT_KEY_CASE_SQL}) AS client_key, x.g
         FROM sa.deals d
         CROSS JOIN LATERAL (
           SELECT d.head_group_name AS g
           UNION
           SELECT p->>'head_group_name' FROM jsonb_array_elements(coalesce(d.products, '[]'::jsonb)) p
            WHERE coalesce(p->>'type', '') <> 'услуга'
         ) x
        WHERE d.funnel_id IN (0, 1, 2, 3) AND d.delivered_at >= $1::date AND d.delivered_at < $2::date
          AND x.g IS NOT NULL AND x.g !~* '^(доставка|перевозка|услуг|разное)'
     ) t WHERE client_key IS NOT NULL GROUP BY 1`,
    [from, to],
  );
  const map = new Map(r.rows.map(x => [x.client_key, x.groups]));
  if (cache.size > 20) cache.clear();
  cache.set(key, { at: Date.now(), map });
  return map;
}
