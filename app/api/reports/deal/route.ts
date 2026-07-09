import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { loadManagerInfoMap, loadSourceMap } from '@/lib/marketing/sources';

// Полная карточка сделки: все поля deals + товары (products jsonb) + справочные
// обогащения (менеджер из org, источник из marketing_sources).
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id || !/^\d+$/.test(id)) {
    return NextResponse.json({ error: 'id (число) обязателен' }, { status: 400 });
  }

  const [res, callsCountRes] = await Promise.all([
    analyticsDb().query(
      `SELECT
         d.deal_id, d.deal_name, d.amount, d.is_reserved,
         d.created_at, d.updated_at, d.reserved_at, d.confirmed_at,
         d.sold_at, d.delivered_at, d.lost_at,
         NULL::timestamptz AS expected_close_date,  -- нет в sa.deals; форму ответа сохраняем
         d.current_manager_id::text AS manager_id,
         d.lead_id, d.contact_id, d.company_id,
         d.source_id, d.products,
         d.product_group_id, pg.name AS product_group_name,
         d.head_group_id, d.head_group_name,
         s.name AS stage_name,
         f.name AS funnel_name, f.is_repeat AS funnel_is_repeat
       FROM deals d
       LEFT JOIN stages s          ON s.id  = d.stage_id
       LEFT JOIN product_groups pg ON pg.id = d.product_group_id
       LEFT JOIN funnels f         ON f.id  = d.funnel_id
       WHERE d.deal_id = $1`,
      [Number(id)],
    ),
    // Только COUNT (индекс idx_calls_deal_created_at, deal_id) — для лейбла таба
    // «Звонки N». Сам список звонков карточка догружает лениво при открытии таба
    // (features/reports/ui/DealCard.tsx, отдельный эндпоинт /api/reports/deal/calls) —
    // не тащим va.calls целиком на каждое открытие карточки.
    analyticsDb().query<{ count: string }>('SELECT count(*) FROM va.calls WHERE deal_id = $1', [Number(id)]),
  ]);
  if (!res.rows.length) return NextResponse.json({ error: 'Сделка не найдена' }, { status: 404 });
  const deal = res.rows[0];
  const callsCount = Number(callsCountRes.rows[0]?.count ?? 0);

  const [mgrInfo, srcMap] = await Promise.all([loadManagerInfoMap(), loadSourceMap()]);
  const manager = deal.manager_id ? mgrInfo.get(deal.manager_id) ?? null : null;
  const source  = deal.source_id ? srcMap.get(deal.source_id) ?? null : null;

  return NextResponse.json({ deal, manager, source, callsCount });
}
