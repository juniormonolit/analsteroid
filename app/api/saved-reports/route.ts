import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import type { SavedReport, SavedReportInput } from '@/lib/saved-reports/types';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = systemDb();
  const res = await db.query<SavedReport>(
    `SELECT id, user_login AS "userLogin", report_slug AS "reportSlug", name,
            metric_ids AS "metricIds", deal_scope AS "dealScope",
            client_type AS "clientType", grouping,
            comparison_display AS "comparisonDisplay",
            product_group_mode AS "productGroupMode",
            department_ids AS "departmentIds",
            metric_highlights AS "metricHighlights",
            COALESCE(metric_display_modes, '{}'::jsonb) AS "metricDisplayModes",
            COALESCE(comparison_threshold, 5) AS "comparisonThreshold",
            COALESCE(pinned_metric_ids, '{}') AS "pinnedMetricIds",
            COALESCE(metric_decimal_overrides, '{}'::jsonb) AS "metricDecimalOverrides",
            COALESCE(metric_threshold_overrides, '{}'::jsonb) AS "metricThresholdOverrides",
            sort_by AS "sortBy",
            sort_dir AS "sortDir",
            COALESCE(column_groups, '[]'::jsonb) AS "columnGroups",
            period_mode AS "periodMode",
            relative_period AS "relativePeriod",
            comparison_mode AS "comparisonMode",
            fixed_period AS "fixedPeriod",
            fixed_comparison AS "fixedComparison",
            created_at AS "createdAt"
     FROM saved_reports
     WHERE user_login = $1
     ORDER BY created_at DESC`,
    [session.login]
  );
  return NextResponse.json(res.rows);
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: SavedReportInput = await req.json();
  const db = systemDb();

  const vals = [
    session.login,
    body.reportSlug,
    body.name,
    body.metricIds,
    body.dealScope,
    body.clientType,
    body.grouping,
    body.comparisonDisplay,
    body.productGroupMode,
    body.departmentIds,
    JSON.stringify(body.metricHighlights),
    JSON.stringify(body.metricDisplayModes ?? {}),
    body.comparisonThreshold ?? 5,
    body.periodMode,
    body.relativePeriod ? JSON.stringify(body.relativePeriod) : null,
    body.comparisonMode,
    body.fixedPeriod ? JSON.stringify(body.fixedPeriod) : null,
    body.fixedComparison ? JSON.stringify(body.fixedComparison) : null,
    body.pinnedMetricIds ?? [],
    JSON.stringify(body.metricDecimalOverrides ?? {}),
    JSON.stringify(body.metricThresholdOverrides ?? {}),
    body.sortBy ?? null,
    body.sortDir ?? null,
    JSON.stringify(body.columnGroups ?? []),
  ];

  const res = await db.query<{ id: string }>(
    `INSERT INTO saved_reports (
       user_login, report_slug, name, metric_ids,
       deal_scope, client_type, grouping, comparison_display, product_group_mode,
       department_ids, metric_highlights,
       metric_display_modes, comparison_threshold,
       period_mode, relative_period, comparison_mode, fixed_period, fixed_comparison,
       pinned_metric_ids, metric_decimal_overrides, metric_threshold_overrides, sort_by, sort_dir,
       column_groups
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     ON CONFLICT (user_login, name) DO UPDATE SET
       report_slug = EXCLUDED.report_slug,
       metric_ids = EXCLUDED.metric_ids,
       deal_scope = EXCLUDED.deal_scope,
       client_type = EXCLUDED.client_type,
       grouping = EXCLUDED.grouping,
       comparison_display = EXCLUDED.comparison_display,
       product_group_mode = EXCLUDED.product_group_mode,
       department_ids = EXCLUDED.department_ids,
       metric_highlights = EXCLUDED.metric_highlights,
       metric_display_modes = EXCLUDED.metric_display_modes,
       comparison_threshold = EXCLUDED.comparison_threshold,
       period_mode = EXCLUDED.period_mode,
       relative_period = EXCLUDED.relative_period,
       comparison_mode = EXCLUDED.comparison_mode,
       fixed_period = EXCLUDED.fixed_period,
       fixed_comparison = EXCLUDED.fixed_comparison,
       pinned_metric_ids = EXCLUDED.pinned_metric_ids,
       metric_decimal_overrides = EXCLUDED.metric_decimal_overrides,
       metric_threshold_overrides = EXCLUDED.metric_threshold_overrides,
       sort_by = EXCLUDED.sort_by,
       sort_dir = EXCLUDED.sort_dir,
       column_groups = EXCLUDED.column_groups
     RETURNING id`,
    vals
  );
  return NextResponse.json({ id: res.rows[0].id });
}
