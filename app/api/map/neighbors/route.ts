import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { HOT_OBJECT_MIN_DEALS } from '@/lib/bitrix/dealAddress';

// «Соседи по объекту» (правка владельца 21.09: из напрашивающегося — делаем всё).
//
// Смысл: менеджер стоит на точке и должен видеть, что вокруг мы УЖЕ работаем.
// Разведка 21.09: 749 «кустов» радиусом ~1 км, где 3+ разных заказчика, дают
// 776 млн за год — больше половины выручки. Значит вопрос «кто рядом» не
// теоретический.
//
// Считаем по ВСЕЙ истории, а не по фильтру отчёта: фильтр отвечает на вопрос
// «что было в периоде», а сосед — на вопрос «есть ли тут наша поляна вообще».
// Отбор — bbox по широте/долготе (индекс deal_addresses_coords_idx), точная
// дистанция добивается в Node по гаверсинусу.

export const maxDuration = 30;

const EARTH_KM = 6371;
const MAX_R_KM = 25;
const MAX_NEIGHBOURS = 60;

function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const lat = Number(sp.get('lat'));
  const lon = Number(sp.get('lon'));
  const radiusKm = Math.min(MAX_R_KM, Math.max(0.2, Number(sp.get('r') ?? '1')));
  const selfKey = sp.get('key') ?? '';
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return NextResponse.json({ error: 'Нет точки' }, { status: 400 });

  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));

  const res = await systemDb().query<{ deal_id: string; obj_key: string; address: string | null; lat: number; lon: number; client_key: string | null }>(
    `WITH hot AS (
       SELECT obj_key FROM deal_addresses WHERE found AND obj_key IS NOT NULL
        GROUP BY 1 HAVING count(*) >= $5
     )
     SELECT deal_id, obj_key, address, lat, lon, client_key
       FROM deal_addresses x
      WHERE found AND lat BETWEEN $1 AND $2 AND lon BETWEEN $3 AND $4
        AND obj_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM hot WHERE hot.obj_key = x.obj_key)
      LIMIT 20000`,
    [lat - dLat, lat + dLat, lon - dLon, lon + dLon, HOT_OBJECT_MIN_DEALS],
  );

  const near = res.rows.filter(r => haversine(lat, lon, r.lat, r.lon) <= radiusKm);
  if (near.length === 0) {
    return NextResponse.json({ radiusKm, objects: 0, deals: 0, sum: 0, clients: 0, lastAt: null, items: [] });
  }

  // Суммы и даты — из SA по id найденных сделок (в кэше адресов денег нет).
  const ids = near.map(r => Number(r.deal_id));
  const sums = new Map<number, { amount: number; at: string | null }>();
  for (let i = 0; i < ids.length; i += 10000) {
    const r = await analyticsDb().query<{ deal_id: string; amount: string | null; at: string | null }>(
      `SELECT d.deal_id::text AS deal_id, d.amount::text AS amount,
              COALESCE(d.delivered_at, d.sold_at)::text AS at
         FROM sa.deals d
        WHERE d.deal_id = ANY($1::bigint[]) AND d.delivered_at IS NOT NULL
          AND d.funnel_id IN (0,1,2,3) AND COALESCE(d.amount,0) BETWEEN 0 AND 50000000`,
      [ids.slice(i, i + 10000)],
    );
    for (const row of r.rows) sums.set(Number(row.deal_id), { amount: Number(row.amount ?? 0) || 0, at: row.at });
  }

  interface Agg { key: string; address: string; lat: number; lon: number; distanceKm: number; deals: number; sum: number; clients: Set<string>; lastAt: string | null }
  const byObj = new Map<string, Agg>();
  const clients = new Set<string>();
  let deals = 0, sum = 0;
  let lastAt: string | null = null;

  for (const r of near) {
    const s = sums.get(Number(r.deal_id));
    if (!s) continue;                       // сделка не отгружена — соседом не считаем
    deals++; sum += s.amount;
    if (r.client_key) clients.add(r.client_key);
    if (s.at && (!lastAt || s.at > lastAt)) lastAt = s.at;
    const o = byObj.get(r.obj_key) ?? {
      key: r.obj_key, address: r.address ?? 'без адреса', lat: r.lat, lon: r.lon,
      distanceKm: Math.round(haversine(lat, lon, r.lat, r.lon) * 100) / 100,
      deals: 0, sum: 0, clients: new Set<string>(), lastAt: null,
    };
    o.deals++; o.sum += s.amount;
    if (r.client_key) o.clients.add(r.client_key);
    if (s.at && (!o.lastAt || s.at > o.lastAt)) o.lastAt = s.at;
    byObj.set(r.obj_key, o);
  }

  const items = [...byObj.values()]
    .filter(o => o.key !== selfKey)
    .sort((a, b) => b.sum - a.sum)
    .slice(0, MAX_NEIGHBOURS)
    .map(o => ({
      key: o.key, address: o.address, lat: o.lat, lon: o.lon, distanceKm: o.distanceKm,
      deals: o.deals, sum: Math.round(o.sum), clients: o.clients.size, lastAt: o.lastAt,
    }));

  return NextResponse.json({
    radiusKm, objects: byObj.size, deals, sum: Math.round(sum), clients: clients.size, lastAt, items,
  });
}
