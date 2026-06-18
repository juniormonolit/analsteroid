import { analyticsDb } from '@/lib/db/clients';
import { systemDb } from '@/lib/db/clients';
import type { DateRange } from '@/lib/period';
import type { DealScope, ReportRow } from '@/lib/metrics/types';
import { addDays } from 'date-fns';

export interface ByManagersOptions {
  period: DateRange;
  dealScope: DealScope;
  departmentIds?: string[]; // system DB department bitrix_ids
}

interface RawManagerRow {
  manager_id: string;
  // Collected milestone counts
  primary_deals_count: number;
  repeat_deals_count: number;
  called_deals_count: number;
  reservations_count: number;
  confirmed_reservations_count: number;
  primary_sales_count: number;
  repeat_sales_count: number;
  primary_sales_amount: number;
  repeat_sales_amount: number;
  primary_shipments_count: number;
  repeat_shipments_count: number;
  primary_shipments_amount: number;
  repeat_shipments_amount: number;
}

export async function fetchByManagers(opts: ByManagersOptions): Promise<ReportRow[]> {
  const db = analyticsDb();
  const sysDb = systemDb();

  // Date boundaries (half-open interval)
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(opts.period.to, 1).toISOString();

  // Load org hierarchy for name/team resolution
  const orgRes = await sysDb.query<{
    bitrix_user_id: string;
    manager_name: string;
    department_id: string | null;
    department_name: string | null;
    rop_bitrix_user_id: string | null;
  }>(`
    SELECT manager_bitrix_user_id AS bitrix_user_id,
           manager_name, department_id, department_name, rop_bitrix_user_id
    FROM org_resolved_hierarchy
  `);
  const orgMap = new Map(orgRes.rows.map(r => [r.bitrix_user_id, r]));

  // If department filter — find allowed bitrix_user_ids
  let allowedManagerIds: Set<string> | null = null;
  if (opts.departmentIds && opts.departmentIds.length > 0) {
    const deptRes = await sysDb.query<{ bitrix_user_id: string }>(
      `SELECT e.bitrix_user_id
       FROM employees e
       JOIN departments d ON d.id = e.department_id
       WHERE d.bitrix_department_id = ANY($1)`,
      [opts.departmentIds]
    );
    allowedManagerIds = new Set(deptRes.rows.map(r => r.bitrix_user_id));
  }

  // Funnel scope filter
  const funnelFilter =
    opts.dealScope === 'all'
      ? ''
      : opts.dealScope === 'primary'
      ? `AND d.funnel_id NOT IN (SELECT id FROM funnels WHERE is_repeat = true)`
      : `AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)`;

  const sql = `
    SELECT
      d.current_manager_id::text AS manager_id,

      -- Primary deals (incoming)
      COUNT(DISTINCT CASE
        WHEN d.created_at >= $1 AND d.created_at < $2
          AND d.funnel_id NOT IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.deal_id END
      ) AS primary_deals_count,

      -- Repeat deals
      COUNT(DISTINCT CASE
        WHEN d.created_at >= $1 AND d.created_at < $2
          AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.deal_id END
      ) AS repeat_deals_count,

      -- Called (unique deals with 'called' event in period)
      COUNT(DISTINCT CASE
        WHEN de.event_at >= $1 AND de.event_at < $2
          AND de.stage_id IN (SELECT id FROM stages WHERE event_type = 'called')
        THEN de.deal_id END
      ) AS called_deals_count,

      -- Reservations
      COUNT(DISTINCT CASE
        WHEN d.reserved_at >= $1 AND d.reserved_at < $2
        THEN d.deal_id END
      ) AS reservations_count,

      -- Confirmed reservations
      COUNT(DISTINCT CASE
        WHEN d.confirmed_at >= $1 AND d.confirmed_at < $2
        THEN d.deal_id END
      ) AS confirmed_reservations_count,

      -- Primary sales count
      COUNT(DISTINCT CASE
        WHEN d.sold_at >= $1 AND d.sold_at < $2
          AND d.funnel_id NOT IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.deal_id END
      ) AS primary_sales_count,

      -- Repeat sales count
      COUNT(DISTINCT CASE
        WHEN d.sold_at >= $1 AND d.sold_at < $2
          AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.deal_id END
      ) AS repeat_sales_count,

      -- Primary sales amount
      COALESCE(SUM(CASE
        WHEN d.sold_at >= $1 AND d.sold_at < $2
          AND d.funnel_id NOT IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.amount ELSE 0 END
      ), 0) AS primary_sales_amount,

      -- Repeat sales amount
      COALESCE(SUM(CASE
        WHEN d.sold_at >= $1 AND d.sold_at < $2
          AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.amount ELSE 0 END
      ), 0) AS repeat_sales_amount,

      -- Primary shipments count
      COUNT(DISTINCT CASE
        WHEN d.delivered_at >= $1 AND d.delivered_at < $2
          AND d.funnel_id NOT IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.deal_id END
      ) AS primary_shipments_count,

      -- Repeat shipments count
      COUNT(DISTINCT CASE
        WHEN d.delivered_at >= $1 AND d.delivered_at < $2
          AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.deal_id END
      ) AS repeat_shipments_count,

      -- Primary shipments amount
      COALESCE(SUM(CASE
        WHEN d.delivered_at >= $1 AND d.delivered_at < $2
          AND d.funnel_id NOT IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.amount ELSE 0 END
      ), 0) AS primary_shipments_amount,

      -- Repeat shipments amount
      COALESCE(SUM(CASE
        WHEN d.delivered_at >= $1 AND d.delivered_at < $2
          AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)
        THEN d.amount ELSE 0 END
      ), 0) AS repeat_shipments_amount

    FROM deals d
    LEFT JOIN deal_events de ON de.deal_id = d.deal_id
    WHERE d.current_manager_id IS NOT NULL
      ${funnelFilter}
      AND (
        (d.created_at >= $1 AND d.created_at < $2)
        OR (d.reserved_at >= $1 AND d.reserved_at < $2)
        OR (d.confirmed_at >= $1 AND d.confirmed_at < $2)
        OR (d.sold_at >= $1 AND d.sold_at < $2)
        OR (d.delivered_at >= $1 AND d.delivered_at < $2)
        OR (de.event_at >= $1 AND de.event_at < $2)
      )
    GROUP BY d.current_manager_id
    ORDER BY primary_deals_count DESC
  `;

  const res = await db.query<RawManagerRow>(sql, [fromIso, toExclIso]);

  // Fetch sales plans for the period (sum all months that overlap)
  const planRes = await db.query<{ manager_id: string; plan_amount: string }>(
    `SELECT manager_id::text, SUM(sales_plan) AS plan_amount
     FROM sales_plans
     WHERE period >= date_trunc('month', $1::date)::date
       AND period <= date_trunc('month', $2::date)::date
     GROUP BY manager_id`,
    [fromIso, toExclIso]
  );
  const planMap = new Map(planRes.rows.map(r => [r.manager_id, Number(r.plan_amount)]));

  return res.rows
    .filter(r => !allowedManagerIds || allowedManagerIds.has(r.manager_id))
    .map(r => {
      const org = orgMap.get(r.manager_id);
      return {
        dimensionId: r.manager_id,
        dimensionName: org?.manager_name ?? `Менеджер ${r.manager_id}`,
        teamId: org?.department_id ?? null,
        teamName: org?.department_name ?? null,
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
          plan_amount: planMap.get(r.manager_id) ?? 0,
        },
      };
    });
}
