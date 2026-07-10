import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isReportAdmin, permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import type { SavedReportInput } from '@/lib/saved-reports/types';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const body: SavedReportInput = await req.json();
  const db = systemDb();

  // Свой отчёт правит только владелец; общий («Роп монитор»/«Смекалочная») —
  // любой админ (не только исходный автор) — п.3б спеки.
  const existing = await db.query<{ user_login: string; is_shared: boolean; deleted_at: Date | null }>(
    `SELECT user_login, is_shared, deleted_at FROM saved_reports WHERE id = $1`,
    [id]
  );
  if (!existing.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const row = existing.rows[0];
  // Корзина (бриф 09.07, п.2): удалённый отчёт не редактируется — сначала «Восстановить»
  // (POST .../restore), потом уже PUT. Иначе правка молча воскрешала бы контент отчёта,
  // не снимая deleted_at, — он остался бы видимым в редакторе, но невидимым в списках.
  if (row.deleted_at !== null) {
    return NextResponse.json({ error: 'Отчёт в корзине — сначала восстановите' }, { status: 409 });
  }
  const isAdmin = isReportAdmin(session);
  if (row.user_login !== session.login && !(row.is_shared && isAdmin)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const requestedSection = body.sharedSection;
  const sharedSection = isAdmin && (requestedSection === 'rop_monitor' || requestedSection === 'smekalochnaya')
    ? requestedSection
    : null;

  await db.query(
    `UPDATE saved_reports SET
       name = $2, metric_ids = $3,
       deal_scope = $4, client_type = $5, grouping = $6,
       comparison_display = $7, product_group_mode = $8,
       department_ids = $9, metric_highlights = $10,
       metric_display_modes = $11, comparison_threshold = $12,
       period_mode = $13, relative_period = $14,
       comparison_mode = $15, fixed_period = $16, fixed_comparison = $17,
       pinned_metric_ids = $18, metric_decimal_overrides = $19,
       metric_threshold_overrides = $20, sort_by = $21, sort_dir = $22,
       column_groups = $23, accented_metric_ids = $24, bar_metric_ids = $25,
       heatmap_metric_ids = $26, theme_accent = $27, number_align = $28, account_type = $29,
       drilldown_duplicate_metrics = $30, drilldown_metric_ids = $31, deal_fields = $32,
       drilldown_grouped = $33, source_dimension = $34, drilldown_dimension = $35,
       is_shared = $36, shared_section = $37, heatmap_inverted_ids = $38, colorize_metrics = $39,
       zebra = $40, border_mode = $41
     WHERE id = $1`,
    [
      id,
      body.name, body.metricIds,
      body.dealScope, body.clientType, body.grouping,
      body.comparisonDisplay, body.productGroupMode,
      body.departmentIds, JSON.stringify(body.metricHighlights),
      JSON.stringify(body.metricDisplayModes ?? {}), body.comparisonThreshold ?? 5,
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
      sharedSection !== null,
      sharedSection,
      body.heatmapInvertedIds ?? [],
      body.colorizeMetrics ?? null,
      body.zebra ?? null,
      body.borderMode ?? null,
    ]
  );
  return NextResponse.json({ ok: true });
}

// Корзина отчётов (бриф 09.07, п.2): DELETE больше не удаляет строку — проставляет
// deleted_at/deleted_by (см. migration 069). Настоящее удаление — отдельный роут
// .../permanent (DELETE), восстановление — .../restore (POST). Раздел корзины —
// GET /api/saved-reports/trash.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = systemDb();

  const existing = await db.query<{ user_login: string; is_shared: boolean; deleted_at: Date | null }>(
    `SELECT user_login, is_shared, deleted_at FROM saved_reports WHERE id = $1`,
    [id]
  );
  if (!existing.rows.length) return NextResponse.json({ ok: true }); // уже удалён — идемпотентно
  const row = existing.rows[0];
  if (row.deleted_at !== null) return NextResponse.json({ ok: true }); // уже в корзине — идемпотентно

  if (row.is_shared) {
    // Общие разделы («Роп монитор»/«Смекалочная») — переместить в корзину может админ
    // (action.shared_reports.manage), тот же уровень, что и сохранение/перезапись
    // (раньше настоящее удаление требовало супер-админа — теперь это восстановимо,
    // планка снижена до isReportAdmin, см. отчёт задачи).
    const err = permError(session, 'action.shared_reports.manage');
    if (err) return err;
    await db.query(`UPDATE saved_reports SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`, [id, session.login]);
  } else {
    if (row.user_login !== session.login) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    await db.query(
      `UPDATE saved_reports SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1 AND user_login = $2`,
      [id, session.login]
    );
  }
  return NextResponse.json({ ok: true });
}
