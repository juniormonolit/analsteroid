import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { addDays } from 'date-fns';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const managerId = searchParams.get('managerId');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const scope = searchParams.get('scope') ?? 'primary'; // primary | repeat | all

  if (!managerId || !from || !to) {
    return NextResponse.json({ error: 'managerId, from, to required' }, { status: 400 });
  }

  const fromDate = new Date(from);
  const toExcl = addDays(new Date(to), 1);

  const funnelFilter =
    scope === 'all' ? '' :
    scope === 'primary'
      ? `AND d.funnel_id NOT IN (SELECT id FROM funnels WHERE is_repeat = true)`
      : `AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)`;

  const db = analyticsDb();
  const res = await db.query(
    `SELECT
       d.deal_id,
       d.deal_name,
       d.amount,
       d.created_at,
       d.reserved_at,
       d.confirmed_at,
       d.sold_at,
       d.delivered_at,
       d.lost_at,
       s.name AS stage_name,
       pg.name AS product_group_name,
       f.name AS funnel_name
     FROM deals d
     LEFT JOIN stages s ON s.id = d.stage_id
     LEFT JOIN product_groups pg ON pg.id = d.product_group_id
     LEFT JOIN funnels f ON f.id = d.funnel_id
     WHERE d.current_manager_id = $1
       ${funnelFilter}
       AND (
         (d.created_at >= $2 AND d.created_at < $3)
         OR (d.sold_at >= $2 AND d.sold_at < $3)
         OR (d.delivered_at >= $2 AND d.delivered_at < $3)
         OR (d.reserved_at >= $2 AND d.reserved_at < $3)
       )
     ORDER BY COALESCE(d.sold_at, d.created_at) DESC
     LIMIT 500`,
    [managerId, fromDate.toISOString(), toExcl.toISOString()]
  );

  return NextResponse.json({ deals: res.rows });
}
