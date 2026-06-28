import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
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

  await db.query(
    `UPDATE saved_reports SET
       name = $3, metric_ids = $4,
       deal_scope = $5, client_type = $6, grouping = $7,
       comparison_display = $8, product_group_mode = $9,
       department_ids = $10, metric_highlights = $11,
       metric_display_modes = $12, comparison_threshold = $13,
       period_mode = $14, relative_period = $15,
       comparison_mode = $16, fixed_period = $17, fixed_comparison = $18,
       pinned_metric_ids = $19, metric_decimal_overrides = $20,
       metric_threshold_overrides = $21, sort_by = $22, sort_dir = $23,
       column_groups = $24
     WHERE id = $1 AND user_login = $2`,
    [
      id, session.login,
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
    ]
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = systemDb();
  await db.query(
    `DELETE FROM saved_reports WHERE id = $1 AND user_login = $2`,
    [id, session.login]
  );
  return NextResponse.json({ ok: true });
}
