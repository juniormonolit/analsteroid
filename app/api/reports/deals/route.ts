import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { addDays, startOfDay } from 'date-fns';

// metricId → which date field to filter and optional funnel type
const METRIC_FILTER_MAP: Record<string, {
  dateField?: 'created_at' | 'sold_at' | 'delivered_at' | 'reserved_at' | 'confirmed_at';
  funnelType?: 'primary' | 'repeat';
  called?: true;
}> = {
  primary_deals_count:          { dateField: 'created_at', funnelType: 'primary' },
  incoming_deals_count:         { dateField: 'created_at' },
  called_deals_count:           { called: true },
  reservations_count:           { dateField: 'reserved_at' },
  confirmed_reservations_count: { dateField: 'confirmed_at' },
  primary_sales_count:          { dateField: 'sold_at', funnelType: 'primary' },
  primary_sales_amount:         { dateField: 'sold_at', funnelType: 'primary' },
  repeat_sales_count:           { dateField: 'sold_at', funnelType: 'repeat' },
  repeat_sales_amount:          { dateField: 'sold_at', funnelType: 'repeat' },
  primary_shipments_count:      { dateField: 'delivered_at', funnelType: 'primary' },
  primary_shipments_amount:     { dateField: 'delivered_at', funnelType: 'primary' },
  repeat_shipments_count:       { dateField: 'delivered_at', funnelType: 'repeat' },
  repeat_shipments_amount:      { dateField: 'delivered_at', funnelType: 'repeat' },
};

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const managerId      = sp.get('managerId');
  const productGroup   = sp.get('productGroup');    // group name (by_max) or id (kc)
  const pgMode         = sp.get('productGroupMode') ?? 'by_max';
  const from           = sp.get('from');
  const to             = sp.get('to');
  const scope          = sp.get('scope') ?? 'primary';
  const metricFilter   = sp.get('metricFilter') ?? '';

  if ((!managerId && !productGroup) || !from || !to) {
    return NextResponse.json({ error: 'managerId or productGroup, plus from/to required' }, { status: 400 });
  }

  const fromDate = new Date(from);
  const toExcl   = addDays(startOfDay(new Date(to)), 1);

  // ── Scope filter ──────────────────────────────────────────────────────────
  const funnelFilter =
    scope === 'all'     ? '' :
    scope === 'primary' ? `AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = false)`
                        : `AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)`;

  // ── Metric date filter ────────────────────────────────────────────────────
  const mf = METRIC_FILTER_MAP[metricFilter];
  let metricDateFilter = `(
    d.created_at >= $1 AND d.created_at < $2
    OR d.sold_at >= $1 AND d.sold_at < $2
    OR d.delivered_at >= $1 AND d.delivered_at < $2
    OR d.reserved_at >= $1 AND d.reserved_at < $2
  )`;
  let extraJoin = '';

  if (mf) {
    if (mf.called) {
      extraJoin = `JOIN (
        SELECT DISTINCT deal_id FROM deal_events
        WHERE event_at >= $1 AND event_at < $2
          AND stage_id IN (SELECT id FROM stages WHERE event_type = 'called')
      ) _called ON _called.deal_id = d.deal_id`;
      metricDateFilter = '1=1';
    } else if (mf.dateField) {
      metricDateFilter = `d.${mf.dateField} >= $1 AND d.${mf.dateField} < $2`;
    }
  }

  // ── Dimension filter ──────────────────────────────────────────────────────
  const params: unknown[] = [fromDate.toISOString(), toExcl.toISOString()];
  let dimensionFilter = '';

  if (managerId) {
    params.push(managerId);
    dimensionFilter = `AND d.current_manager_id = $${params.length}`;
  } else if (productGroup !== null) {
    if (pgMode === 'kc') {
      if (productGroup === '__none__') {
        dimensionFilter = `AND d.product_group_id IS NULL`;
      } else {
        params.push(productGroup);
        dimensionFilter = `AND d.product_group_id::text = $${params.length}`;
      }
    } else {
      // by_max
      if (productGroup === 'Без группы' || productGroup === '__none__') {
        dimensionFilter = `AND d.head_group_name IS NULL`;
      } else {
        params.push(productGroup);
        dimensionFilter = `AND d.head_group_name = $${params.length}`;
      }
    }
  }

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
      d.current_manager_id::text AS manager_id,
      s.name  AS stage_name,
      pg.name AS product_group_name,
      d.head_group_name,
      f.name  AS funnel_name
    FROM deals d
    ${extraJoin}
    LEFT JOIN stages s          ON s.id  = d.stage_id
    LEFT JOIN product_groups pg ON pg.id = d.product_group_id
    LEFT JOIN funnels f         ON f.id  = d.funnel_id
    WHERE ${metricDateFilter}
      ${dimensionFilter}
      ${funnelFilter}
    ORDER BY COALESCE(d.sold_at, d.delivered_at, d.created_at) DESC
    LIMIT 1000
  `;

  const res = await db.query(sql, params);

  const deals = (res.rows as {
    manager_id: string;
    head_group_name: string | null;
    product_group_name: string | null;
  }[]).map(r => ({
    ...r,
    product_group_display: pgMode === 'by_max'
      ? (r.head_group_name    ?? 'Без группы')
      : (r.product_group_name ?? 'Без группы'),
  }));

  return NextResponse.json({ deals });
}
