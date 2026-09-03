import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { ycAnalyticsDb } from '@/lib/db/clients';
import { invalidateMetricsCache } from '@/lib/metrics/catalog';

// JSON с детерминированным порядком ключей — для сравнения filters «как есть в БД»
// с тем, что пришло в body. jsonb хранит ключи в своём порядке (по длине, потом по
// алфавиту), body — в порядке вставки формой, поэтому голый JSON.stringify обеих
// сторон различался бы на одинаковых по смыслу фильтрах.
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

// null/undefined и пустая строка — одно и то же «не задано».
const normStr = (v: unknown): string => (v == null ? '' : String(v));

interface MetricDefinitionRow {
  formula: string | null;
  filters: unknown;
  agg_fn: string | null;
  agg_field: string | null;
  date_field: string | null;
  metric_type: string;
  source: string;
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = permError(session, 'section.metrics');
  if (denied) return denied;

  const { id } = await params;
  const body = await req.json();
  const db = ycAnalyticsDb();

  // Отметка «Проверено» (миграция 192) не должна переживать правку ОПРЕДЕЛЕНИЯ
  // метрики: владелец сверял с Битриксом конкретную формулу/фильтры, после их
  // смены галочка врёт. Поэтому перед UPDATE читаем текущее определение и, если
  // хоть одно из полей formula / filters / agg_fn / agg_field / date_field /
  // metric_type / source реально меняется — в том же UPDATE обнуляем verified_*.
  // Правка названий, описаний, категории, флагов видимости отметку не трогает.
  // Сравниваем ровно те значения, которые уйдут в UPDATE (с теми же дефолтами).
  const cur = await db.query<MetricDefinitionRow>(`
    SELECT formula, filters, agg_fn, agg_field, date_field, metric_type,
           COALESCE(source, 'deals') AS source
    FROM metrics WHERE id = $1
  `, [id]);
  const prev = cur.rows[0];
  const definitionChanged = !!prev && (
    normStr(prev.formula) !== normStr(body.formula ?? null) ||
    stableJson(prev.filters ?? []) !== stableJson(body.filters ?? []) ||
    normStr(prev.agg_fn) !== normStr(body.agg_fn ?? null) ||
    normStr(prev.agg_field) !== normStr(body.agg_field ?? null) ||
    normStr(prev.date_field) !== normStr(body.date_field ?? null) ||
    normStr(prev.metric_type) !== normStr(body.metric_type ?? 'collected') ||
    normStr(prev.source) !== normStr(body.source ?? 'deals')
  );

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
      fill_ok          = $22,
      verified_at      = CASE WHEN $25::boolean THEN NULL ELSE verified_at END,
      verified_by      = CASE WHEN $25::boolean THEN NULL ELSE verified_by END
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
    definitionChanged,
  ]);

  invalidateMetricsCache();
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = permError(session, 'section.metrics');
  if (denied) return denied;

  const { id } = await params;
  const db = ycAnalyticsDb();
  await db.query('DELETE FROM metrics WHERE id = $1', [id]);
  invalidateMetricsCache();
  return NextResponse.json({ ok: true });
}
