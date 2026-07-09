import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isReportAdmin } from '@/lib/auth/perms';
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
            COALESCE(heatmap_inverted_ids, '{}') AS "heatmapInvertedIds",
            colorize_metrics AS "colorizeMetrics",
            zebra AS "zebra",
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
     FROM saved_reports
     WHERE user_login = $1 OR is_shared = true
     ORDER BY created_at DESC`,
    [session.login]
  );
  return NextResponse.json(res.rows);
}

type SharedSection = 'rop_monitor' | 'smekalochnaya' | null;

// Общие для INSERT/UPDATE колонки (без identity-полей user_login/report_slug/name,
// которые ведут себя по-разному в личном/общем сценарии — см. POST ниже).
function buildCommonFields(body: SavedReportInput, sharedSection: SharedSection): Record<string, unknown> {
  return {
    metric_ids: body.metricIds,
    deal_scope: body.dealScope,
    client_type: body.clientType,
    grouping: body.grouping,
    comparison_display: body.comparisonDisplay,
    product_group_mode: body.productGroupMode,
    department_ids: body.departmentIds,
    metric_highlights: JSON.stringify(body.metricHighlights),
    metric_display_modes: JSON.stringify(body.metricDisplayModes ?? {}),
    comparison_threshold: body.comparisonThreshold ?? 5,
    period_mode: body.periodMode,
    relative_period: body.relativePeriod ? JSON.stringify(body.relativePeriod) : null,
    comparison_mode: body.comparisonMode,
    fixed_period: body.fixedPeriod ? JSON.stringify(body.fixedPeriod) : null,
    fixed_comparison: body.fixedComparison ? JSON.stringify(body.fixedComparison) : null,
    pinned_metric_ids: body.pinnedMetricIds ?? [],
    metric_decimal_overrides: JSON.stringify(body.metricDecimalOverrides ?? {}),
    metric_threshold_overrides: JSON.stringify(body.metricThresholdOverrides ?? {}),
    sort_by: body.sortBy ?? null,
    sort_dir: body.sortDir ?? null,
    column_groups: JSON.stringify(body.columnGroups ?? []),
    accented_metric_ids: body.accentedMetricIds ?? [],
    bar_metric_ids: body.barMetricIds ?? [],
    heatmap_metric_ids: body.heatmapMetricIds ?? [],
    theme_accent: body.themeAccent ?? null,
    number_align: body.numberAlign ?? null,
    account_type: body.accountType ?? null,
    drilldown_duplicate_metrics: body.drilldownDuplicateMetrics ?? null,
    drilldown_metric_ids: body.drilldownMetricIds ?? [],
    deal_fields: body.dealFields ?? null,
    drilldown_grouped: body.drilldownGrouped ?? null,
    source_dimension: body.sourceDimension ?? null,
    drilldown_dimension: body.drilldownDimension ?? null,
    is_shared: sharedSection !== null,
    shared_section: sharedSection,
    heatmap_inverted_ids: body.heatmapInvertedIds ?? [],
    colorize_metrics: body.colorizeMetrics ?? null,
    zebra: body.zebra ?? null,
  };
}

function buildInsert(table: string, fields: Record<string, unknown>) {
  const cols = Object.keys(fields);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const values = cols.map((c) => fields[c]);
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
    values,
  };
}

function buildUpdateById(table: string, fields: Record<string, unknown>, id: string) {
  const cols = Object.keys(fields);
  const setClauses = cols.map((c, i) => `${c} = $${i + 1}`);
  const values = cols.map((c) => fields[c]);
  values.push(id);
  return {
    sql: `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING id`,
    values,
  };
}

function buildUpsertOnConflict(
  table: string,
  fields: Record<string, unknown>,
  conflictCols: string[],
  conflictWhere?: string
) {
  const cols = Object.keys(fields);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const values = cols.map((c) => fields[c]);
  const updates = cols.filter((c) => !conflictCols.includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
  // Партиционный уникальный индекс (например saved_reports_personal_user_name_unique,
  // migration 058) требует, чтобы ON CONFLICT указывал тот же WHERE, что и индекс —
  // иначе Postgres не сможет сопоставить конфликт с этим индексом.
  const conflictTarget = conflictWhere
    ? `(${conflictCols.join(', ')}) WHERE ${conflictWhere}`
    : `(${conflictCols.join(', ')})`;
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
          ON CONFLICT ${conflictTarget} DO UPDATE SET ${updates.join(', ')}
          RETURNING id`,
    values,
  };
}

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: SavedReportInput = await req.json();
  const db = systemDb();

  // Раздел общей витрины (п.3б спеки) — задать может только админ
  // (action.shared_reports.manage); для остальных всегда null → личный отчёт.
  const isAdmin = isReportAdmin(session);
  const requested = body.sharedSection;
  const sharedSection: SharedSection =
    isAdmin && (requested === 'rop_monitor' || requested === 'smekalochnaya') ? requested : null;

  const fields = buildCommonFields(body, sharedSection);

  try {
    if (sharedSection) {
      // Общий раздел: имя уникально ВНУТРИ раздела (частичный индекс
      // saved_reports_shared_section_name_unique) — любой админ перезаписывает
      // существующий отчёт того же раздела/имени, не только собственный.
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM saved_reports WHERE is_shared = true AND shared_section = $1 AND name = $2`,
        [sharedSection, body.name]
      );
      if (existing.rows.length) {
        const { sql, values } = buildUpdateById('saved_reports', { ...fields, name: body.name, report_slug: body.reportSlug }, existing.rows[0].id);
        await db.query(sql, values);
        return NextResponse.json({ id: existing.rows[0].id });
      }
      // user_login здесь — только «автор записи» (для отображения), уникальность
      // общего имени обеспечена индексом (shared_section, name) выше, а не (user_login,
      // name) — см. migration 058: старый table-wide constraint сузили до личных
      // отчётов, иначе INSERT падал, если у автора уже был личный отчёт с тем же именем.
      const { sql, values } = buildInsert('saved_reports', {
        user_login: session.login,
        report_slug: body.reportSlug,
        name: body.name,
        ...fields,
      });
      const res = await db.query<{ id: string }>(sql, values);
      return NextResponse.json({ id: res.rows[0].id });
    }

    // Личный отчёт: перезаписывается только свой же (user_login, name) — как раньше.
    // Партиционный индекс saved_reports_personal_user_name_unique (migration 058)
    // ограничивает конфликт только личными (NOT is_shared) строками этого автора.
    const { sql, values } = buildUpsertOnConflict(
      'saved_reports',
      { user_login: session.login, report_slug: body.reportSlug, name: body.name, ...fields },
      ['user_login', 'name'],
      'NOT is_shared'
    );
    const res = await db.query<{ id: string }>(sql, values);
    return NextResponse.json({ id: res.rows[0].id });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Гонка (TOCTOU) между SELECT existing и INSERT в общем разделе, либо
      // clash после старой версии constraint — отдаём понятную ошибку вместо
      // голого 500, чтобы фронтенд не проглатывал сбой молча.
      return NextResponse.json(
        { error: 'Отчёт с таким названием уже существует в этом разделе — обновите страницу и попробуйте снова' },
        { status: 409 }
      );
    }
    console.error('[saved-reports] POST failed:', err);
    return NextResponse.json({ error: 'Не удалось сохранить отчёт' }, { status: 500 });
  }
}
