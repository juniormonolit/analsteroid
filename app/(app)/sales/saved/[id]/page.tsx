import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import type { SavedReport } from '@/lib/saved-reports/types';
import { SalesReportPage } from '@/features/reports/ui/SalesReportPage';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Задача 2824 (аудит, раздел 3): раньше ЛЮБОЙ отказ — «сессии нет», «отчёта
// не существует», «отчёт существует, но чужой и не расшарен» — отвечал одним
// и тем же generic notFound(). Это САМЫЙ частый «сущностный» URL приложения
// (боты «Аналитик»/«Стас» шлют именно такие ссылки на конкретный отчёт), и
// «страница не найдена» для «нет прав» вводит в заблуждение: получатель решает,
// что отчёт удалили, хотя на самом деле его просто не расшарили. Три случая
// теперь различаются:
//  1. нет сессии → redirect('/login') (как везде в проекте);
//  2. строки в БД вообще нет (или soft-deleted) → notFound() — это ЧЕСТНЫЙ 404,
//     отчёт правда не существует;
//  3. строка есть, но не твоя и не расшарена → AccessDenied — было отчёт,
//     просто не для тебя.
export default async function SavedReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { id } = await params;
  // ?new=1 — как у /sales/by-*: открыть отчёт в СВЕЖЕЙ вкладке, без состояния,
  // восстановленного из localStorage (reportTabs.ts) — ровно как он сохранён.
  const { new: newParam } = await searchParams;
  const session = await getSession();
  if (!session) redirect('/login');

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
            COALESCE(metric_borders, '{}'::jsonb) AS "metricBorders",
            COALESCE(metric_threshold_overrides, '{}'::jsonb) AS "metricThresholdOverrides",
            sort_by AS "sortBy",
            sort_dir AS "sortDir",
            COALESCE(column_groups, '[]'::jsonb) AS "columnGroups",
            COALESCE(deal_filters, '[]'::jsonb) AS "dealFilters",
            COALESCE(accented_metric_ids, '{}') AS "accentedMetricIds",
            COALESCE(bar_metric_ids, '{}') AS "barMetricIds",
            COALESCE(heatmap_metric_ids, '{}') AS "heatmapMetricIds",
            COALESCE(heatmap_inverted_ids, '{}') AS "heatmapInvertedIds",
            colorize_metrics AS "colorizeMetrics",
            zebra AS "zebra",
            border_mode AS "borderMode",
            theme_accent AS "themeAccent",
            number_align AS "numberAlign",
            account_type AS "accountType",
            drilldown_duplicate_metrics AS "drilldownDuplicateMetrics",
            COALESCE(drilldown_metric_ids, '{}') AS "drilldownMetricIds",
            deal_fields AS "dealFields",
            drilldown_grouped AS "drilldownGrouped",
            source_dimension AS "sourceDimension",
            drilldown_dimension AS "drilldownDimension",
            period_unit AS "periodUnit",
            period_dimension AS "periodDimension",
            compare_mode AS "compareMode",
            is_shared AS "isShared",
            shared_section AS "sharedSection",
            period_mode AS "periodMode",
            relative_period AS "relativePeriod",
            comparison_mode AS "comparisonMode",
            fixed_period AS "fixedPeriod",
            fixed_comparison AS "fixedComparison",
            created_at AS "createdAt"
     FROM saved_reports
     WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );

  // Случай 2: отчёта правда нет (или в корзине) — честный 404.
  if (!res.rows.length) return notFound();
  const preset = res.rows[0];

  // Случай 3: отчёт существует, но не твой и не расшарен — «недостаточно
  // прав», не «страницы нет». (Владелец видит свой отчёт всегда; is_shared —
  // видимость витрины «Роп монитор»/«Отчёты Стаса», не зависит от ролевых
  // прав section.* — доступ к самим витринам управляется навигацией/ссылкой.)
  if (preset.userLogin !== session.login && !preset.isShared) {
    return <AccessDenied reason="Этот отчёт вам недоступен — он не ваш и не расшарен. Попросите автора расшарить отчёт или пришлите ссылку на свою копию." />;
  }

  return (
    <SalesReportPage
      reportSlug={preset.reportSlug}
      title={preset.name}
      preset={preset}
      isNew={newParam === '1'}
    />
  );
}
