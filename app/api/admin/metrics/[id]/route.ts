import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { ycAnalyticsDb } from '@/lib/db/clients';
import { invalidateMetricsCache } from '@/lib/metrics/catalog';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const body = await req.json();
  const db = ycAnalyticsDb();

  await db.query(`
    UPDATE metrics SET
      name_ru          = $1,
      name_short_ru    = $2,
      description      = $3,
      metric_type      = $4,
      data_type        = $5,
      formula          = $6,
      dependencies     = $7,
      decimal_places   = $8,
      aggregation_fn   = $9,
      category         = $10,
      sort_order       = $11,
      is_core          = $12,
      is_active        = $13,
      is_hidden_in_ui  = $14,
      is_test          = $15,
      source           = $16,
      agg_fn           = $17,
      agg_field        = $18,
      date_field       = $19,
      filters          = $20::jsonb,
      tags             = $21,
      is_collect_ok    = $22,
      is_calc_ok       = $23,
      calc_ok          = $23,
      fill_ok          = $22
    WHERE id = $24
  `, [
    body.name_ru,
    body.name_short_ru ?? null,
    body.description ?? null,
    body.metric_type ?? 'collected',
    body.data_type ?? 'int',
    body.formula ?? null,
    body.dependencies ?? [],
    body.decimal_places ?? 0,
    body.aggregation_fn ?? 'sum',
    body.category ?? null,
    body.sort_order ?? 999,
    body.is_core ?? false,
    body.is_active ?? false,
    body.is_hidden_in_ui ?? false,
    body.is_test ?? false,
    body.source ?? 'deals',
    body.agg_fn ?? null,
    body.agg_field ?? null,
    body.date_field ?? null,
    JSON.stringify(body.filters ?? []),
    body.tags ?? [],
    body.is_collect_ok ?? false,
    body.is_calc_ok ?? false,
    id,
  ]);

  invalidateMetricsCache();
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const db = ycAnalyticsDb();
  await db.query('DELETE FROM metrics WHERE id = $1', [id]);
  invalidateMetricsCache();
  return NextResponse.json({ ok: true });
}
