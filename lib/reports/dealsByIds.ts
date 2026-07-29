import { analyticsDb } from '@/lib/db/clients';
import { loadManagerInfoMap, loadSourceMap } from '@/lib/marketing/sources';

// Гидрация плоского списка сделок по явному набору deal_id (задача 2546, дрилл-
// даун из графиков — features/charts/*). ТА ЖЕ форма строки (SELECT + мэппинг),
// что и app/api/reports/deals/route.ts, — специально не трогаем сам роут
// (перегружен инцидентами #2340..#2390, риск регрессии), а выносим сюда только
// хвост «взять точные deal_id → отдать готовые строки Deal[]», общий для
// /api/reports/deals (в перспективе) и новых /api/charts/*/deals роутов.
// LIMIT 1000 + безлимитный count/sum — тот же паттерн (#2369): «Итого» не должно
// зависеть от урезанного списком.

export interface HydratedDeal {
  deal_id: number;
  deal_name: string;
  amount: string;
  created_at: string;
  reserved_at: string | null;
  confirmed_at: string | null;
  sold_at: string | null;
  delivered_at: string | null;
  lost_at: string | null;
  logist_request_at: string | null;
  cheaper_price_at: string | null;
  expected_close_date: string | null;
  source_id: string | null;
  source_name: string | null;
  manager_id: string;
  manager_name: string | null;
  stage_name: string | null;
  stage_event_type: string | null;
  product_group_display: string;
  funnel_name: string | null;
  team_id: string | null;
  team_name: string | null;
  branch_name: string | null;
}

export interface DealsByIdsResult {
  deals: HydratedDeal[];
  total_count: number;
  total_amount: number;
}

export async function fetchDealsByIds(dealIds: number[], pgMode: 'kc' | 'by_max'): Promise<DealsByIdsResult> {
  if (dealIds.length === 0) return { deals: [], total_count: 0, total_amount: 0 };

  const db = analyticsDb();

  const sql = `
    SELECT
      d.deal_id,
      d.deal_name,
      d.amount,
      d.created_at,
      d.reserved_at,
      d.confirmed_at,
      d.sold_at,
      d.delivered_at,
      d.lost_at,
      (SELECT MIN(de.event_at) FROM deal_events de
        WHERE de.deal_id = d.deal_id
          AND de.stage_id IN (SELECT id FROM stages WHERE name ILIKE 'Сделал запрос снабженцу%')
      ) AS logist_request_at,
      (SELECT MIN(de.event_at) FROM deal_events de
        WHERE de.deal_id = d.deal_id
          AND de.stage_id IN (SELECT id FROM stages WHERE name ILIKE 'Есть цена дешевле%' OR name ILIKE 'Есть ниже цена%')
      ) AS cheaper_price_at,
      NULL::timestamptz AS expected_close_date,
      d.source_id,
      d.current_manager_id::text AS manager_id,
      s.name  AS stage_name,
      s.event_type AS stage_event_type,
      pg.name AS product_group_name,
      d.head_group_name,
      f.name  AS funnel_name
    FROM deals d
    LEFT JOIN stages s          ON s.id  = d.stage_id
    LEFT JOIN product_groups pg ON pg.id = d.product_group_id
    LEFT JOIN funnels f         ON f.id  = d.funnel_id
    WHERE d.deal_id = ANY($1::int[])
    ORDER BY COALESCE(d.sold_at, d.delivered_at, d.created_at) DESC
    LIMIT 1000
  `;

  const countSql = `
    SELECT COUNT(*)::int AS total_count, COALESCE(SUM(amount), 0)::numeric AS total_amount
    FROM deals
    WHERE deal_id = ANY($1::int[])
  `;

  const [res, countRes, mgrInfo, srcMap] = await Promise.all([
    db.query(sql, [dealIds]),
    db.query<{ total_count: number; total_amount: string }>(countSql, [dealIds]),
    loadManagerInfoMap(),
    loadSourceMap(),
  ]);

  const deals = (res.rows as {
    manager_id: string;
    source_id: string | null;
    head_group_name: string | null;
    product_group_name: string | null;
  }[]).map(r => ({
    ...r,
    manager_name: mgrInfo.get(r.manager_id)?.name ?? (r.manager_id ? `#${r.manager_id}` : null),
    source_name: r.source_id ? (srcMap.get(r.source_id)?.name ?? r.source_id) : null,
    product_group_display: pgMode === 'by_max'
      ? (r.head_group_name    ?? 'Без группы')
      : (r.product_group_name ?? 'Без группы'),
    team_id: mgrInfo.get(r.manager_id)?.departmentId ?? null,
    team_name: mgrInfo.get(r.manager_id)?.department ?? null,
    branch_name: mgrInfo.get(r.manager_id)?.branch ?? 'СПб',
  })) as unknown as HydratedDeal[];

  return {
    deals,
    total_count: countRes.rows[0]?.total_count ?? 0,
    total_amount: Number(countRes.rows[0]?.total_amount ?? 0),
  };
}
