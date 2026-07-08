import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { ycAnalyticsDb } from '@/lib/db/clients';
import { invalidateMetricsCache } from '@/lib/metrics/catalog';

export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'section.metrics');
  if (denied) return denied;

  const db = ycAnalyticsDb();
  const res = await db.query(`
    SELECT id, name_ru, name_short_ru, description,
           metric_type, data_type, formula, dependencies,
           decimal_places, aggregation_fn, category, sort_order,
           is_core, is_active, is_hidden_in_ui,
           COALESCE(is_test, false) AS is_test,
           COALESCE(source, 'deals') AS source,
           agg_fn, agg_field, date_field,
           COALESCE(filters, '[]'::jsonb) AS filters,
           COALESCE(tags, '{}') AS tags,
           COALESCE(is_collect_ok, false) AS is_collect_ok,
           COALESCE(is_calc_ok, false) AS is_calc_ok
    FROM metrics
    ORDER BY sort_order, name_ru
  `);
  return NextResponse.json({ metrics: res.rows });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.metrics');
  if (denied) return denied;

  const body = await req.json();
  const db = ycAnalyticsDb();

  const res = await db.query(`
    INSERT INTO metrics (
      id, name_ru, name_short_ru, description,
      metric_type, data_type, formula, dependencies,
      decimal_places, aggregation_fn, category, sort_order,
      is_core, is_active, is_hidden_in_ui, is_test,
      source, agg_fn, agg_field, date_field, filters, tags,
      is_collect_ok, is_calc_ok,
      calc_ok, fill_ok
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      $9, $10, $11, $12,
      $13, $14, $15, $16,
      $17, $18, $19, $20, $21::jsonb, $22,
      $23, $24,
      $24, $23
    )
    RETURNING *
  `, [
    body.id,
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
  ]);

  invalidateMetricsCache();
  return NextResponse.json(res.rows[0], { status: 201 });
}
