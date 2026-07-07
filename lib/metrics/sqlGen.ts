import type { Metric, MetricFilter } from './types';

export interface DimensionConfig {
  idExpr: string;           // SQL expr for the ID column, e.g. "d.current_manager_id::text"
  nameExpr?: string;        // SQL expr for name (optional, e.g. for product groups)
  extraJoins?: string;      // Additional JOINs
  groupBy: string;          // GROUP BY clause (must include funnel_id if funnelBreakdown=true)
  notNullWhere?: string;    // Extra WHERE condition
  funnelBreakdown?: boolean; // Add d.funnel_id to SELECT for pill filtering
}

// All identifiers below (column names, metric ids) come from the admin-only metrics
// catalog (metrics.filters / agg_field / date_field / id, editable via /api/admin/metrics
// and /api/settings/metrics). They are inlined into raw SQL as column/table identifiers,
// which can't be parameterized with $n placeholders — so we validate them against a strict
// allowlist pattern instead. This is defense-in-depth: an admin account is not meant to be
// equivalent to raw SQL access against the analytics DB (e.g. a stolen admin session
// shouldn't be able to pivot into arbitrary SQL via a crafted metric definition).
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function assertIdentifier(name: string, what: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Metric config error: invalid ${what} "${name}" (expected a plain SQL identifier)`);
  }
  return name;
}

/** Escape a string for use inside a single-quoted SQL text literal. */
function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function sqlLiteral(v: string | number): string {
  return typeof v === 'number' ? String(v) : sqlString(String(v));
}

export function resolveFilterClause(f: MetricFilter, tableAlias: string): string {
  const a = tableAlias;
  if (f.field === '_ppp') {
    return `d.deal_id IN (
      SELECT deal_id FROM (
        SELECT deal_id, ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY sold_at) AS rn
        FROM sa.deals WHERE sold_at IS NOT NULL
      ) _ppp_ranked WHERE rn = 2
    )`;
  }
  if (f.field === '_ppo') {
    return `d.deal_id IN (
      SELECT deal_id FROM (
        SELECT deal_id, ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY delivered_at) AS rn
        FROM sa.deals WHERE delivered_at IS NOT NULL
      ) _ppo_ranked WHERE rn = 2
    )`;
  }
  if (f.field === 'funnel_type') {
    const v = f.value as string;
    if (v === 'primary') return `${a}.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = false)`;
    if (v === 'repeat')  return `${a}.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)`;
    if (v === 'b2c')     return `${a}.funnel_id IN (0, 2)`;
    if (v === 'b2b')     return `${a}.funnel_id IN (1, 3)`;
    return '';
  }
  if (f.field === 'event_type') {
    return `de.stage_id IN (SELECT id FROM stages WHERE event_type = ${sqlLiteral(String(f.value))})`;
  }
  if (f.field === 'stage_type') {
    return `${a}.stage_id IN (SELECT id FROM stages WHERE event_type = ${sqlLiteral(String(f.value))})`;
  }
  // gt_field: column-vs-column comparison, value = other column name (e.g. lost_at > sold_at).
  // Implies both NOT NULL (SQL comparison with NULL is never true).
  if (f.op === 'gt_field') {
    const other = String(f.value);
    if (!IDENT_RE.test(other) || !IDENT_RE.test(f.field)) return '';
    return `${a}.${f.field} > ${a}.${other}`;
  }
  // is_null / is_not_null: special handling for product_rows (also check empty jsonb array)
  if (f.op === 'is_null') {
    assertIdentifier(f.field, 'filter field');
    if (f.field === 'products') {
      return `(${a}.products IS NULL OR jsonb_array_length(${a}.products) = 0)`;
    }
    return `${a}.${f.field} IS NULL`;
  }
  if (f.op === 'is_not_null') {
    assertIdentifier(f.field, 'filter field');
    return `${a}.${f.field} IS NOT NULL`;
  }

  assertIdentifier(f.field, 'filter field');
  const vals = Array.isArray(f.value)
    ? (f.value as (string | number)[]).map(sqlLiteral).join(', ')
    : null;

  switch (f.op) {
    case 'eq':      return `${a}.${f.field} = ${sqlLiteral(f.value as string | number)}`;
    case 'neq':     return `${a}.${f.field} != ${sqlLiteral(f.value as string | number)}`;
    case 'in':      return vals ? `${a}.${f.field} IN (${vals})` : '';
    case 'not_in':  return vals ? `${a}.${f.field} NOT IN (${vals})` : '';
    default: return '';
  }
}

function genDealsExpr(m: Metric): string {
  assertIdentifier(m.id, 'metric id');
  assertIdentifier(m.dateField!, 'date field');
  if (m.aggField) assertIdentifier(m.aggField, 'agg field');

  const when: string[] = [
    `d.${m.dateField} >= $1`,
    `d.${m.dateField} < $2`,
    ...m.filters.map(f => resolveFilterClause(f, 'd')).filter(Boolean),
  ];
  const cond = when.join(' AND ');

  switch (m.aggFn) {
    case 'count_distinct':
      return `COUNT(DISTINCT CASE WHEN ${cond} THEN d.${m.aggField} END) AS ${m.id}`;
    case 'sum':
      return `COALESCE(SUM(CASE WHEN ${cond} THEN d.${m.aggField} ELSE 0 END), 0) AS ${m.id}`;
    case 'avg':
      return `AVG(CASE WHEN ${cond} THEN d.${m.aggField} END) AS ${m.id}`;
    case 'count_all':
      return `COUNT(CASE WHEN ${cond} THEN 1 END) AS ${m.id}`;
    default:
      return `NULL::numeric AS ${m.id}`;
  }
}

function genEventsExpr(m: Metric): string {
  assertIdentifier(m.id, 'metric id');
  assertIdentifier(m.dateField!, 'date field');
  if (m.aggField) assertIdentifier(m.aggField, 'agg field');

  const evtWhere: string[] = [
    `de.deal_id = d.deal_id`,
    `de.${m.dateField} >= $1`,
    `de.${m.dateField} < $2`,
    ...m.filters.map(f => resolveFilterClause(f, 'de')).filter(Boolean),
  ];
  const where = evtWhere.join('\n       AND ');

  switch (m.aggFn) {
    case 'count_distinct':
      return `(SELECT COUNT(DISTINCT de.${m.aggField}) FROM deal_events de WHERE ${where}) AS ${m.id}`;
    case 'count_all':
      return `(SELECT COUNT(*) FROM deal_events de WHERE ${where}) AS ${m.id}`;
    case 'sum':
      return `(SELECT COALESCE(SUM(de.${m.aggField}), 0) FROM deal_events de WHERE ${where}) AS ${m.id}`;
    case 'avg':
      return `(SELECT AVG(de.${m.aggField}) FROM deal_events de WHERE ${where}) AS ${m.id}`;
    default:
      return `(SELECT COUNT(DISTINCT de.${m.aggField}) FROM deal_events de WHERE ${where}) AS ${m.id}`;
  }
}

/**
 * Build the full collected-metrics SQL for a given dimension.
 * Returns empty string if no collected metrics are passed.
 */
export function buildCollectedSQL(
  metrics: Metric[],
  dim: DimensionConfig,
): string {
  const collected = metrics.filter(
    m => m.metricType === 'collected' && m.aggFn && m.aggField && m.dateField,
  );
  if (collected.length === 0) return '';

  const dealsM  = collected.filter(m => m.source === 'deals');
  const eventsM = collected.filter(m => m.source === 'deal_events');

  // WHERE: a deal is in scope if any of its date fields fall in the period,
  // OR if it has any event in period (for event-sourced metrics).
  const dateFields = [...new Set(dealsM.map(m => assertIdentifier(m.dateField!, 'date field')))];
  const dateConds  = dateFields.map(f => `(d.${f} >= $1 AND d.${f} < $2)`);
  if (eventsM.length > 0) {
    const evtDateField = assertIdentifier(eventsM[0].dateField!, 'date field');
    dateConds.push(
      `EXISTS (SELECT 1 FROM deal_events _e WHERE _e.deal_id = d.deal_id AND _e.${evtDateField} >= $1 AND _e.${evtDateField} < $2)`,
    );
  }

  const selectCols: string[] = [
    `${dim.idExpr} AS dimension_id`,
    ...(dim.nameExpr ? [`${dim.nameExpr} AS dimension_name`] : []),
    ...(dim.funnelBreakdown ? [`d.funnel_id`] : []),
    ...dealsM.map(genDealsExpr),
    ...eventsM.map(genEventsExpr),
  ];

  const whereParts: string[] = [];
  if (dim.notNullWhere) whereParts.push(dim.notNullWhere);
  if (dateConds.length > 0) {
    whereParts.push(`(\n    ${dateConds.join('\n    OR ')}\n  )`);
  } else {
    whereParts.push('1=0'); // no metrics → no rows
  }

  return `
SELECT
  ${selectCols.join(',\n  ')}
FROM deals d
${dim.extraJoins ?? ''}
WHERE ${whereParts.join('\n  AND ')}
${dim.groupBy}
  `.trim();
}
