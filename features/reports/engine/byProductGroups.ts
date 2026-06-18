import { analyticsDb } from '@/lib/db/clients';
import type { DateRange } from '@/lib/period';
import type { DealScope, ReportRow } from '@/lib/metrics/types';
import { addDays } from 'date-fns';

export interface ByProductGroupsOptions {
  period: DateRange;
  dealScope: DealScope;
  funnelIds?: number[];
}

export async function fetchByProductGroups(opts: ByProductGroupsOptions): Promise<ReportRow[]> {
  const db = analyticsDb();

  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(opts.period.to, 1).toISOString();

  const funnelFilter =
    opts.dealScope === 'all'
      ? ''
      : opts.dealScope === 'primary'
      ? `AND d.funnel_id NOT IN (SELECT id FROM funnels WHERE is_repeat = true)`
      : `AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)`;

  const sql = `
    SELECT
      COALESCE(d.product_group_id::text, '__none__') AS group_id,
      COALESCE(pg.name, 'Без группы') AS group_name,

      COUNT(DISTINCT CASE
        WHEN d.created_at >= $1 AND d.created_at < $2
          AND d.funnel_id NOT IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.deal_id END
      ) AS primary_deals_count,

      COUNT(DISTINCT CASE
        WHEN d.created_at >= $1 AND d.created_at < $2
          AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.deal_id END
      ) AS repeat_deals_count,

      COUNT(DISTINCT CASE
        WHEN de.event_at >= $1 AND de.event_at < $2
          AND de.stage_id IN (SELECT id FROM stages WHERE event_type = 'called')
        THEN de.deal_id END
      ) AS called_deals_count,

      COUNT(DISTINCT CASE WHEN d.reserved_at >= $1 AND d.reserved_at < $2 THEN d.deal_id END) AS reservations_count,
      COUNT(DISTINCT CASE WHEN d.confirmed_at >= $1 AND d.confirmed_at < $2 THEN d.deal_id END) AS confirmed_reservations_count,

      COUNT(DISTINCT CASE
        WHEN d.sold_at >= $1 AND d.sold_at < $2
          AND d.funnel_id NOT IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.deal_id END
      ) AS primary_sales_count,

      COUNT(DISTINCT CASE
        WHEN d.sold_at >= $1 AND d.sold_at < $2
          AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.deal_id END
      ) AS repeat_sales_count,

      COALESCE(SUM(CASE
        WHEN d.sold_at >= $1 AND d.sold_at < $2
          AND d.funnel_id NOT IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.amount ELSE 0 END), 0) AS primary_sales_amount,

      COALESCE(SUM(CASE
        WHEN d.sold_at >= $1 AND d.sold_at < $2
          AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.amount ELSE 0 END), 0) AS repeat_sales_amount,

      COUNT(DISTINCT CASE
        WHEN d.delivered_at >= $1 AND d.delivered_at < $2
          AND d.funnel_id NOT IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.deal_id END
      ) AS primary_shipments_count,

      COUNT(DISTINCT CASE
        WHEN d.delivered_at >= $1 AND d.delivered_at < $2
          AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.deal_id END
      ) AS repeat_shipments_count,

      COALESCE(SUM(CASE
        WHEN d.delivered_at >= $1 AND d.delivered_at < $2
          AND d.funnel_id NOT IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.amount ELSE 0 END), 0) AS primary_shipments_amount,

      COALESCE(SUM(CASE
        WHEN d.delivered_at >= $1 AND d.delivered_at < $2
          AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.amount ELSE 0 END), 0) AS repeat_shipments_amount

    FROM deals d
    LEFT JOIN product_groups pg ON pg.id = d.product_group_id
    LEFT JOIN deal_events de ON de.deal_id = d.deal_id
    WHERE 1=1
      ${funnelFilter}
      AND (
        (d.created_at >= $1 AND d.created_at < $2)
        OR (d.reserved_at >= $1 AND d.reserved_at < $2)
        OR (d.confirmed_at >= $1 AND d.confirmed_at < $2)
        OR (d.sold_at >= $1 AND d.sold_at < $2)
        OR (d.delivered_at >= $1 AND d.delivered_at < $2)
        OR (de.event_at >= $1 AND de.event_at < $2)
      )
    GROUP BY d.product_group_id, pg.name
    ORDER BY primary_sales_amount DESC
  `;

  const res = await db.query(sql, [fromIso, toExclIso]);

  return res.rows.map(r => ({
    dimensionId: r.group_id,
    dimensionName: r.group_name,
    teamId: null,
    teamName: null,
    metrics: {
      primary_deals_count: Number(r.primary_deals_count),
      incoming_deals_count: Number(r.primary_deals_count),
      repeat_deals_count: Number(r.repeat_deals_count),
      called_deals_count: Number(r.called_deals_count),
      reservations_count: Number(r.reservations_count),
      confirmed_reservations_count: Number(r.confirmed_reservations_count),
      primary_sales_count: Number(r.primary_sales_count),
      repeat_sales_count: Number(r.repeat_sales_count),
      primary_sales_amount: Number(r.primary_sales_amount),
      repeat_sales_amount: Number(r.repeat_sales_amount),
      primary_shipments_count: Number(r.primary_shipments_count),
      repeat_shipments_count: Number(r.repeat_shipments_count),
      primary_shipments_amount: Number(r.primary_shipments_amount),
      repeat_shipments_amount: Number(r.repeat_shipments_amount),
    },
  }));
}
