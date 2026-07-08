import { notFound } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import type { SavedReport } from '@/lib/saved-reports/types';
import { SalesReportPage } from '@/features/reports/ui/SalesReportPage';

export default async function SavedReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return notFound();

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
            COALESCE(heatmap_inverted_ids, '{}') AS "heatmapInvertedIds",
            colorize_metrics AS "colorizeMetrics",
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
            shared_section AS "sharedSection",
            period_mode AS "periodMode",
            relative_period AS "relativePeriod",
            comparison_mode AS "comparisonMode",
            fixed_period AS "fixedPeriod",
            fixed_comparison AS "fixedComparison",
            created_at AS "createdAt"
     FROM saved_reports WHERE id = $1 AND (user_login = $2 OR is_shared = true)`,
    [id, session.login]
  );

  if (!res.rows.length) return notFound();
  const preset = res.rows[0];

  return (
    <SalesReportPage
      reportSlug={preset.reportSlug}
      title={preset.name}
      preset={preset}
    />
  );
}
