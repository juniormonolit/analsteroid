import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadManagerInfoMap } from '@/lib/marketing/sources';
import { getSessionScope, scopeDeptIdsBitrix } from '@/lib/org/sessionScope';
import { hotObjectKeys } from '@/lib/bitrix/dealAddress';

// Карта КОНВЕРСИИ (задача владельца 21.09: «включая фильтр утеплитель, я хочу
// видеть, где территориально у меня самая низкая конверсия? Для меня это будет
// означать, что в этом районе есть проблема со снабжением»).
//
// Ключевое отличие от «Карты объектов»: единица измерения — не объект, а
// КВАДРАТ СЕТКИ. Конверсия по одному адресу, где было 1–2 сделки, — это шум
// (0% или 100%), территориальную проблему на таком не увидишь. Поэтому точки
// сворачиваются в ячейки заданного размера (5/10/25/50 км), а ячейки с малым
// числом сделок прячутся порогом.
//
// Когорта честная: знаменатель — сделки, СОЗДАННЫЕ в периоде; числитель — те
// из них, что дошли до продажи / до отгрузки. Это те же «CR Сделка → Продажа»
// и «CR Сделка → Отгрузка», что в каталоге метрик, только в разрезе географии.
// Смотреть «продажи периода / сделки периода» было бы неверно: это разные
// множества сделок, и на карте вылезали бы ячейки с конверсией выше 100%.

export const maxDuration = 60;

const MAX_DEALS = 80_000;
const MAX_CELLS = 4_000;
const ADDR_CHUNK = 5_000;
const KM_PER_DEG_LAT = 111;

interface DealRow {
  deal_id: string; amount: string | null; manager_id: string | null; head_group_name: string | null;
  created_at: string | null; sold: boolean; delivered: boolean; deal_name: string | null;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const from = sp.get('from');
  const to = sp.get('to');
  if (!from || !to) return NextResponse.json({ error: 'Не задан период' }, { status: 400 });

  const funnel = sp.get('funnel') === 'primary' ? 'primary' : sp.get('funnel') === 'repeat' ? 'repeat' : 'all';
  const clientType = sp.get('client') === 'company' ? 'company' : sp.get('client') === 'contact' ? 'contact' : 'all';
  const groups = (sp.get('groups') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const managers = (sp.get('managers') ?? '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s));
  const depts = (sp.get('depts') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const minAmount = Number(sp.get('min') ?? '') || 0;
  const maxAmount = Number(sp.get('max') ?? '') || 0;
  const cellKm = [5, 10, 25, 50].includes(Number(sp.get('cell'))) ? Number(sp.get('cell')) : 25;
  const minDeals = Math.max(1, Math.min(100, Number(sp.get('minDeals') ?? '5') || 5));

  const scope = await getSessionScope(session);
  const info = await loadManagerInfoMap();
  let allowedManagers: Set<string> | null = null;
  if (scope.kind === 'self') {
    allowedManagers = new Set(session.bitrixUserId ? [session.bitrixUserId] : []);
  } else if (scope.kind === 'depts') {
    const deptBitrixIds = new Set(await scopeDeptIdsBitrix(scope, undefined) ?? []);
    allowedManagers = new Set([...info].filter(([, i]) => i.departmentId && deptBitrixIds.has(i.departmentId)).map(([id]) => id));
  }
  if (allowedManagers && allowedManagers.size === 0) return NextResponse.json(emptyBody(cellKm, minDeals));

  const funnelIds = funnel === 'primary' ? [0, 2] : funnel === 'repeat' ? [1, 3] : [0, 1, 2, 3];
  const params: unknown[] = [from, to, funnelIds];
  const where: string[] = [
    `d.funnel_id = ANY($3::int[])`,
    `COALESCE(d.amount, 0) BETWEEN 0 AND 50000000`,
    // Когорта по СОЗДАНИЮ: «из сделок, заведённых в периоде, сколько дошло до…»
    `d.created_at >= $1::timestamptz AND d.created_at < $2::timestamptz`,
  ];
  if (allowedManagers) { params.push([...allowedManagers]); where.push(`d.current_manager_id::text = ANY($${params.length}::text[])`); }
  if (minAmount > 0) { params.push(minAmount); where.push(`d.amount >= $${params.length}`); }
  if (maxAmount > 0) { params.push(maxAmount); where.push(`d.amount <= $${params.length}`); }
  if (clientType === 'company') where.push(`d.funnel_id IN (1,3)`);
  if (clientType === 'contact') where.push(`d.funnel_id IN (0,2)`);

  params.push(MAX_DEALS);
  const res = await analyticsDb().query<DealRow>(
    `SELECT d.deal_id::text AS deal_id, d.amount::text AS amount, d.current_manager_id::text AS manager_id,
            d.head_group_name, d.created_at::text AS created_at, d.deal_name,
            (d.sold_at IS NOT NULL) AS sold, (d.delivered_at IS NOT NULL) AS delivered
       FROM sa.deals d
      WHERE ${where.join(' AND ')}
      ORDER BY d.deal_id DESC
      LIMIT $${params.length}`,
    params,
  );
  const deals = res.rows;
  if (deals.length === 0) return NextResponse.json(emptyBody(cellKm, minDeals));

  const ids = deals.map(d => Number(d.deal_id));
  const addr = new Map<number, { address: string | null; lat: number; lon: number; objKey: string }>();
  for (let i = 0; i < ids.length; i += ADDR_CHUNK) {
    const r = await systemDb().query<{ deal_id: string; address: string | null; lat: number; lon: number; obj_key: string }>(
      `SELECT deal_id, address, lat, lon, obj_key FROM deal_addresses
        WHERE found AND lat IS NOT NULL AND obj_key IS NOT NULL AND deal_id = ANY($1::bigint[])`,
      [ids.slice(i, i + ADDR_CHUNK)],
    );
    for (const row of r.rows) addr.set(Number(row.deal_id), { address: row.address, lat: row.lat, lon: row.lon, objKey: row.obj_key });
  }
  const hot = await hotObjectKeys();

  const groupSet = new Set(groups), managerSet = new Set(managers), deptSet = new Set(depts);
  const passGroup = (g: string) => groupSet.size === 0 || groupSet.has(g);
  const passManager = (id: string | null) => managerSet.size === 0 || (!!id && managerSet.has(id));
  const passDept = (dep: string | null) => deptSet.size === 0 || (!!dep && deptSet.has(dep));

  interface Cell {
    key: string; latIdx: number; lonIdx: number; latStep: number; lonStep: number;
    deals: number; sold: number; delivered: number; sum: number; soldSum: number;
    addresses: Map<string, { address: string; deals: number; sold: number }>;
    items: { dealId: number; amount: number; at: string | null; manager: string | null; group: string | null; address: string | null; sold: boolean; delivered: boolean }[];
  }
  const cells = new Map<string, Cell>();
  const facetGroups = new Map<string, { group: string; deals: number; sum: number }>();
  const facetManagers = new Map<string, { id: string; name: string; department: string | null; deals: number; sum: number }>();
  const facetDepts = new Map<string, { department: string; deals: number; sum: number }>();
  const latStep = cellKm / KM_PER_DEG_LAT;
  let total = 0, sold = 0, delivered = 0, withoutCoords = 0;

  for (const d of deals) {
    const a = addr.get(Number(d.deal_id));
    const amount = Number(d.amount ?? 0) || 0;
    const mi = d.manager_id ? info.get(d.manager_id) : undefined;
    const g = d.head_group_name ?? 'Без группы';
    const dep = mi?.department ?? null;
    const okGroup = passGroup(g), okManager = passManager(d.manager_id), okDept = passDept(dep);

    if (okGroup && okDept && d.manager_id) {
      const f = facetManagers.get(d.manager_id) ?? { id: d.manager_id, name: mi?.name ?? `#${d.manager_id}`, department: dep, deals: 0, sum: 0 };
      f.deals++; f.sum += amount; facetManagers.set(d.manager_id, f);
    }
    if (okManager && okDept) {
      const fg = facetGroups.get(g) ?? { group: g, deals: 0, sum: 0 };
      fg.deals++; fg.sum += amount; facetGroups.set(g, fg);
    }
    if (okGroup && okManager && dep) {
      const fd = facetDepts.get(dep) ?? { department: dep, deals: 0, sum: 0 };
      fd.deals++; fd.sum += amount; facetDepts.set(dep, fd);
    }
    if (!okGroup || !okManager || !okDept) continue;
    if (!a || hot.has(a.objKey)) { withoutCoords++; continue; }

    total++;
    if (d.sold) sold++;
    if (d.delivered) delivered++;

    // Шаг по долготе считается от широты ячейки — иначе на севере квадраты
    // вытягиваются в километрах и «районы» получаются разного размера.
    const latIdx = Math.floor(a.lat / latStep);
    const bandLat = (latIdx + 0.5) * latStep;
    const lonStep = cellKm / (KM_PER_DEG_LAT * Math.max(0.15, Math.cos((bandLat * Math.PI) / 180)));
    const lonIdx = Math.floor(a.lon / lonStep);
    const key = `${latIdx}:${lonIdx}`;
    const c: Cell = cells.get(key) ?? {
      key, latIdx, lonIdx, latStep, lonStep,
      deals: 0, sold: 0, delivered: 0, sum: 0, soldSum: 0,
      addresses: new Map(), items: [],
    };
    c.deals++; c.sum += amount;
    if (d.sold) { c.sold++; c.soldSum += amount; }
    if (d.delivered) c.delivered++;
    const ad = c.addresses.get(a.objKey) ?? { address: a.address ?? 'без адреса', deals: 0, sold: 0 };
    ad.deals++; if (d.sold) ad.sold++;
    c.addresses.set(a.objKey, ad);
    if (c.items.length < 40) {
      c.items.push({
        dealId: Number(d.deal_id), amount, at: d.created_at, manager: mi?.name ?? null,
        group: d.head_group_name, address: a.address, sold: d.sold, delivered: d.delivered,
      });
    }
    cells.set(key, c);
  }

  const out = [...cells.values()]
    .filter(c => c.deals >= minDeals)
    .sort((a, b) => b.deals - a.deals)
    .slice(0, MAX_CELLS)
    .map(c => ({
      key: c.key,
      // Границы квадрата — их и рисует карта.
      bounds: [[c.latIdx * c.latStep, c.lonIdx * c.lonStep], [(c.latIdx + 1) * c.latStep, (c.lonIdx + 1) * c.lonStep]] as [[number, number], [number, number]],
      lat: (c.latIdx + 0.5) * c.latStep, lon: (c.lonIdx + 0.5) * c.lonStep,
      deals: c.deals, sold: c.sold, delivered: c.delivered,
      convSale: c.deals > 0 ? Math.round((c.sold / c.deals) * 1000) / 10 : 0,
      convShip: c.deals > 0 ? Math.round((c.delivered / c.deals) * 1000) / 10 : 0,
      sum: Math.round(c.sum), soldSum: Math.round(c.soldSum),
      topAddresses: [...c.addresses.values()].sort((x, y) => y.deals - x.deals).slice(0, 8),
      items: c.items,
    }));

  return NextResponse.json({
    cells: out,
    cellKm, minDeals,
    summary: {
      deals: total, sold, delivered, withoutCoords,
      convSale: total > 0 ? Math.round((sold / total) * 1000) / 10 : 0,
      convShip: total > 0 ? Math.round((delivered / total) * 1000) / 10 : 0,
      cells: out.length, hiddenCells: cells.size - out.length,
      truncated: deals.length >= MAX_DEALS,
    },
    facets: {
      managers: [...facetManagers.values()].sort((a, b) => b.sum - a.sum),
      groups: [...facetGroups.values()].sort((a, b) => b.sum - a.sum),
      departments: [...facetDepts.values()].sort((a, b) => b.sum - a.sum),
    },
  });
}

function emptyBody(cellKm: number, minDeals: number) {
  return {
    cells: [], cellKm, minDeals,
    summary: { deals: 0, sold: 0, delivered: 0, withoutCoords: 0, convSale: 0, convShip: 0, cells: 0, hiddenCells: 0, truncated: false },
    facets: { managers: [], groups: [], departments: [] },
  };
}
