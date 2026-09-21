import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadManagerInfoMap } from '@/lib/marketing/sources';
import { getSessionScope, scopeDeptIdsBitrix } from '@/lib/org/sessionScope';
import { hotObjectKeys } from '@/lib/bitrix/dealAddress';

// Спец-отчёт «Карта объектов» (задача владельца 21.09: «хочу спецотчет в „Ещё“,
// чтобы там можно было на карте смотреть все. Крутецкий отчет со всеми
// стандартными фильтрами логикой дриллдауна»).
//
// Данные сшиваются из ДВУХ баз: сделки — SA (sa.deals), координаты — системная
// (deal_addresses, кэш Битрикса). Кросс-базного джойна нет, поэтому порядок
// такой: отбираем сделки по фильтрам в SA → тянем их адреса из системной БД
// пачками по id → группируем по ОБЪЕКТУ (obj_key: координаты с точностью
// ~100 м). Точка карты = объект, а не сделка: на один адрес часто возят
// несколько раз, и «3 сделки на 1,2 млн» — ровно то, что нужно видеть.
//
// Гигиена данных как во всех отчётах: воронки 4 и 7 исключены, суммы вне
// 0…50 млн — мусор (пять сделок с 11 111 111 111 111 ₽).

export const maxDuration = 60;

const FUNNELS_ALL = [0, 1, 2, 3];
const FUNNELS_PRIMARY = [0, 2];
const FUNNELS_REPEAT = [1, 3];
const MAX_DEALS = 60_000;
const MAX_OBJECTS = 20_000;
const ADDR_CHUNK = 5_000;

type Basis = 'sold' | 'delivered' | 'created';
type State = 'all' | 'sold' | 'delivered' | 'lost' | 'active';

const BASIS_COL: Record<Basis, string> = { sold: 'd.sold_at', delivered: 'd.delivered_at', created: 'd.created_at' };

interface DealRow {
  deal_id: string; amount: string | null; manager_id: string | null; head_group_name: string | null;
  funnel_id: number; deal_name: string | null; at: string | null;
  company_id: string | null; contact_id: string | null;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const basis = (['sold', 'delivered', 'created'] as const).find(b => b === sp.get('basis')) ?? 'delivered';
  const state = (['all', 'sold', 'delivered', 'lost', 'active'] as const).find(s => s === sp.get('state')) ?? 'delivered';
  const funnel = sp.get('funnel') === 'primary' ? 'primary' : sp.get('funnel') === 'repeat' ? 'repeat' : 'all';
  const from = sp.get('from');
  const to = sp.get('to');
  const groups = (sp.get('groups') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const managers = (sp.get('managers') ?? '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s));
  const depts = (sp.get('depts') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const minAmount = Number(sp.get('min') ?? '') || 0;
  const maxAmount = Number(sp.get('max') ?? '') || 0;
  const clientType = sp.get('client') === 'company' ? 'company' : sp.get('client') === 'contact' ? 'contact' : 'all';
  const buildersOnly = sp.get('builders') === '1';
  // Служебные точки (дефолты Битрикса, «просто город») по умолчанию скрыты:
  // 32 таких адреса собрали треть всех сделок базы и превращают карту в кляксу
  // над центром Петербурга. Показать можно галкой.
  const withHot = sp.get('hot') === '1';

  if (!from || !to) return NextResponse.json({ error: 'Не задан период' }, { status: 400 });

  // Срез сессии: раздел админский, но если право выдано роли — показываем
  // только её отделы (тот же приём, что в остальных отчётах).
  const scope = await getSessionScope(session);
  const info = await loadManagerInfoMap();
  let allowedManagers: Set<string> | null = null;
  if (scope.kind === 'self') {
    allowedManagers = new Set(session.bitrixUserId ? [session.bitrixUserId] : []);
  } else if (scope.kind === 'depts') {
    const deptBitrixIds = new Set(await scopeDeptIdsBitrix(scope, undefined) ?? []);
    allowedManagers = new Set([...info].filter(([, i]) => i.departmentId && deptBitrixIds.has(i.departmentId)).map(([id]) => id));
  }

  const funnelIds = funnel === 'primary' ? FUNNELS_PRIMARY : funnel === 'repeat' ? FUNNELS_REPEAT : FUNNELS_ALL;
  const params: unknown[] = [from, to, funnelIds];
  const where: string[] = [
    `d.funnel_id = ANY($3::int[])`,
    `coalesce(d.amount, 0) BETWEEN 0 AND 50000000`,
  ];
  // База даты и состояние — связаны: «отгрузки» считаем по delivered_at и т.д.
  const dateCol = state === 'lost' ? 'd.lost_at'
    : state === 'sold' ? 'd.sold_at'
    : state === 'delivered' ? 'd.delivered_at'
    : BASIS_COL[basis];
  if (state === 'active') {
    // В работе: не продана, не отгружена, не отказ — период по созданию.
    where.push(`d.sold_at IS NULL AND d.delivered_at IS NULL AND d.lost_at IS NULL`);
    where.push(`d.created_at >= $1::timestamptz AND d.created_at < $2::timestamptz`);
  } else {
    where.push(`${dateCol} IS NOT NULL`);
    where.push(`${dateCol} >= $1::timestamptz AND ${dateCol} < $2::timestamptz`);
  }
  // ВАЖНО (правка владельца 21.09 «а фильтровать-то по товарным группам как?»):
  // фильтры ПО ФАСЕТАМ — группы, менеджеры, отделы — в SQL НЕ уходят. Иначе
  // после выбора одной группы список групп схлопывался до неё же, и добавить
  // вторую было неоткуда. Они применяются в Node, а каждый фасет считается по
  // выборке, отфильтрованной ОСТАЛЬНЫМИ фасетами (обычное faceted search):
  // список групп — с учётом менеджера и отдела, но без фильтра групп, и т.д.
  if (allowedManagers && allowedManagers.size === 0) {
    return NextResponse.json({ objects: [], summary: emptySummary(), facets: emptyFacets() });
  }
  if (allowedManagers) { params.push([...allowedManagers]); where.push(`d.current_manager_id::text = ANY($${params.length}::text[])`); }
  if (minAmount > 0) { params.push(minAmount); where.push(`d.amount >= $${params.length}`); }
  if (maxAmount > 0) { params.push(maxAmount); where.push(`d.amount <= $${params.length}`); }
  if (clientType === 'company') where.push(`d.funnel_id IN (1,3)`);
  if (clientType === 'contact') where.push(`d.funnel_id IN (0,2)`);

  params.push(MAX_DEALS);
  const sql = `
    SELECT d.deal_id::text AS deal_id, d.amount::text AS amount, d.current_manager_id::text AS manager_id,
           d.head_group_name, d.funnel_id, d.deal_name,
           ${state === 'active' ? 'd.created_at' : dateCol} AS at,
           d.company_id::text AS company_id, d.contact_id::text AS contact_id
      FROM sa.deals d
     WHERE ${where.join(' AND ')}
     ORDER BY d.deal_id DESC
     LIMIT $${params.length}`;

  const dealsRes = await analyticsDb().query<DealRow>(sql, params);
  const deals = dealsRes.rows;
  if (deals.length === 0) return NextResponse.json({ objects: [], summary: emptySummary(), facets: emptyFacets() });

  // Адреса — из системной БД пачками (кросс-базного джойна нет).
  const ids = deals.map(d => Number(d.deal_id));
  const addr = new Map<number, { address: string | null; lat: number | null; lon: number | null; objKey: string | null; clientKey: string | null; isPickup: boolean }>();
  for (let i = 0; i < ids.length; i += ADDR_CHUNK) {
    const chunk = ids.slice(i, i + ADDR_CHUNK);
    const r = await systemDb().query<{ deal_id: string; address: string | null; lat: number | null; lon: number | null; obj_key: string | null; client_key: string | null; is_pickup: boolean }>(
      `SELECT deal_id, address, lat, lon, obj_key, client_key, is_pickup FROM deal_addresses
        WHERE found AND lat IS NOT NULL AND deal_id = ANY($1::bigint[])`, [chunk],
    );
    for (const row of r.rows) {
      addr.set(Number(row.deal_id), {
        address: row.address, lat: row.lat, lon: row.lon, objKey: row.obj_key,
        clientKey: row.client_key, isPickup: row.is_pickup,
      });
    }
  }

  // «Только строители»: заказчик с 2+ разными объектами по ВСЕЙ истории.
  let builderKeys: Set<string> | null = null;
  if (buildersOnly) {
    const keys = [...new Set([...addr.values()].map(a => a.clientKey).filter((k): k is string => !!k))];
    builderKeys = new Set<string>();
    for (let i = 0; i < keys.length; i += ADDR_CHUNK) {
      const r = await systemDb().query<{ client_key: string }>(
        `SELECT client_key FROM deal_addresses
          WHERE found AND obj_key IS NOT NULL AND client_key = ANY($1::text[])
          GROUP BY client_key HAVING count(DISTINCT obj_key) >= 2`, [keys.slice(i, i + ADDR_CHUNK)],
      );
      for (const row of r.rows) builderKeys.add(row.client_key);
    }
  }

  const hot = await hotObjectKeys();
  const groupSet = new Set(groups);
  const managerSet = new Set(managers);
  const deptSet = new Set(depts);
  const passGroup = (g: string) => groupSet.size === 0 || groupSet.has(g);
  const passManager = (id: string | null) => managerSet.size === 0 || (!!id && managerSet.has(id));
  const passDept = (dep: string | null) => deptSet.size === 0 || (!!dep && deptSet.has(dep));

  interface ObjAgg {
    key: string; lat: number; lon: number; address: string; hot: boolean;
    deals: number; sum: number; clients: Set<string>;
    /** Состав по товарным группам — раскраска точек и разбивка в дрилле (правка 21.09). */
    groups: Map<string, { deals: number; sum: number }>;
    items: { dealId: number; amount: number; at: string | null; manager: string | null; group: string | null; name: string | null }[];
  }
  const byObj = new Map<string, ObjAgg>();
  const summary = { deals: 0, sum: 0, objects: 0, withoutCoords: 0, hidden: 0, pickup: 0, clients: new Set<string>(), truncated: deals.length >= MAX_DEALS };
  const facetManagers = new Map<string, { id: string; name: string; department: string | null; deals: number; sum: number }>();
  const facetGroups = new Map<string, { group: string; deals: number; sum: number }>();
  const facetDepts = new Map<string, { department: string; deals: number; sum: number }>();

  for (const d of deals) {
    const a = addr.get(Number(d.deal_id));
    const amount = Number(d.amount ?? 0) || 0;
    if (!a || a.lat === null || a.lon === null || !a.objKey) { summary.withoutCoords++; continue; }
    // Самовывоз («Париж», правило владельца 21.09): точки доставки нет вовсе —
    // на карту не ставим, но и в «без координат» не пишем, считаем отдельно.
    if (a.isPickup) { summary.pickup++; continue; }
    const isHot = hot.has(a.objKey);
    if (isHot && !withHot) { summary.hidden++; continue; }
    if (builderKeys && (!a.clientKey || !builderKeys.has(a.clientKey))) continue;

    const mi = d.manager_id ? info.get(d.manager_id) : undefined;
    const g = d.head_group_name ?? 'Без группы';
    const dep = mi?.department ?? null;
    const okGroup = passGroup(g), okManager = passManager(d.manager_id), okDept = passDept(dep);

    // Фасеты: каждый считается «без своего фильтра», чтобы список не схлопывался.
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

    // На карту и в итоги — только то, что прошло ВСЕ фильтры.
    if (!okGroup || !okManager || !okDept) continue;
    summary.deals++; summary.sum += amount;
    if (a.clientKey) summary.clients.add(a.clientKey);

    const o: ObjAgg = byObj.get(a.objKey) ?? {
      key: a.objKey, lat: a.lat, lon: a.lon, address: a.address ?? 'без адреса',
      deals: 0, sum: 0, clients: new Set<string>(), groups: new Map(), items: [], hot: isHot,
    };
    o.deals++; o.sum += amount;
    if (a.clientKey) o.clients.add(a.clientKey);
    const og = o.groups.get(g) ?? { deals: 0, sum: 0 };
    og.deals++; og.sum += amount; o.groups.set(g, og);
    // Список сделок объекта — для дрилл-дауна; больше 50 на одну точку не нужно.
    if (o.items.length < 50) {
      o.items.push({ dealId: Number(d.deal_id), amount, at: d.at, manager: mi?.name ?? null, group: d.head_group_name, name: d.deal_name });
    }
    byObj.set(a.objKey, o);
  }

  const objects = [...byObj.values()]
    .sort((a, b) => b.sum - a.sum)
    .slice(0, MAX_OBJECTS)
    .map(o => {
      const groups = [...o.groups.entries()]
        .map(([group, v]) => ({ group, deals: v.deals, sum: Math.round(v.sum) }))
        .sort((x, y) => y.sum - x.sum);
      return {
        key: o.key, lat: o.lat, lon: o.lon, address: o.address, hot: o.hot,
        deals: o.deals, sum: Math.round(o.sum), clients: o.clients.size,
        // Ведущая группа объекта — по деньгам: ею красится точка на карте.
        topGroup: groups[0]?.group ?? null,
        groups: groups.slice(0, 5),
        items: o.items,
      };
    });

  return NextResponse.json({
    objects,
    summary: {
      deals: summary.deals, sum: Math.round(summary.sum), objects: byObj.size,
      clients: summary.clients.size, withoutCoords: summary.withoutCoords,
      hiddenServiceDeals: summary.hidden, pickupDeals: summary.pickup,
      shown: objects.length, truncated: summary.truncated,
    },
    facets: {
      managers: [...facetManagers.values()].sort((a, b) => b.sum - a.sum),
      groups: [...facetGroups.values()].sort((a, b) => b.sum - a.sum),
      departments: [...facetDepts.values()].sort((a, b) => b.sum - a.sum),
    },
  });
}

function emptySummary() {
  return { deals: 0, sum: 0, objects: 0, clients: 0, withoutCoords: 0, hiddenServiceDeals: 0, pickupDeals: 0, shown: 0, truncated: false };
}
function emptyFacets() {
  return { managers: [], groups: [], departments: [] };
}
