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
            COALESCE(accented_metric_ids, '{}') AS "accentedMetricIds",
            COALESCE(bar_metric_ids, '{}') AS "barMetricIds",
            COALESCE(heatmap_metric_ids, '{}') AS "heatmapMetricIds",
            theme_accent AS "themeAccent",
            number_align AS "numberAlign",
            account_type AS "accountType",
            drilldown_duplicate_metrics AS "drilldownDuplicateMetrics",
            COALESCE(drilldown_metric_ids, '{}') AS "drilldownMetricIds",
            deal_fields AS "dealFields",
            drilldown_grouped AS "drilldownGrouped",
            source_dimension AS "sourceDimension",
            drilldown_dimension AS "drilldownDimension",
            is_shared AS "isShared",
            period_mode AS "periodMode",
            relative_period AS "relativePeriod",
            comparison_mode AS "comparisonMode",
            fixed_period AS "fixedPeriod",
            fixed_comparison AS "fixedComparison",
            created_at AS "createdAt"
     FROM saved_reports
     WHERE user_login = $1 OR is_shared = true
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
    body.accentedMetricIds ?? [],
    body.barMetricIds ?? [],
    body.heatmapMetricIds ?? [],
    body.themeAccent ?? null,
    body.numberAlign ?? null,
    body.accountType ?? null,
    body.drilldownDuplicateMetrics ?? null,
    body.drilldownMetricIds ?? [],
    body.dealFields ?? null,
    body.drilldownGrouped ?? null,
    body.sourceDimension ?? null,
    body.drilldownDimension ?? null,
    // «Смекалочная» (общие отчёты) — сохранять туда может только админ
    session.isAdmin ? (body.isShared ?? false) : false,
  ];

  const res = await db.query<{ id: string }>(
    `INSERT INTO saved_reports (
       user_login, report_slug, name, metric_ids,
       deal_scope, client_type, grouping, comparison_display, product_group_mode,
       department_ids, metric_highlights,
       metric_display_modes, comparison_threshold,
       period_mode, relative_period, comparison_mode, fixed_period, fixed_comparison,
       pinned_metric_ids, metric_decimal_overrides, metric_threshold_overrides, sort_by, sort_dir,
       column_groups, accented_metric_ids, bar_metric_ids, heatmap_metric_ids, theme_accent,
       number_align, account_type, drilldown_duplicate_metrics, drilldown_metric_ids, deal_fields,
       drilldown_grouped, source_dimension, drilldown_dimension, is_shared
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)
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
       column_groups = EXCLUDED.column_groups,
       accented_metric_ids = EXCLUDED.accented_metric_ids,
       bar_metric_ids = EXCLUDED.bar_metric_ids,
       heatmap_metric_ids = EXCLUDED.heatmap_metric_ids,
       theme_accent = EXCLUDED.theme_accent,
       number_align = EXCLUDED.number_align,
       account_type = EXCLUDED.account_type,
       drilldown_duplicate_metrics = EXCLUDED.drilldown_duplicate_metrics,
       drilldown_metric_ids = EXCLUDED.drilldown_metric_ids,
       deal_fields = EXCLUDED.deal_fields,
       drilldown_grouped = EXCLUDED.drilldown_grouped,
       source_dimension = EXCLUDED.source_dimension,
       drilldown_dimension = EXCLUDED.drilldown_dimension,
       is_shared = EXCLUDED.is_shared
     RETURNING id`,
    vals
  );
  return NextResponse.json({ id: res.rows[0].id });
}
