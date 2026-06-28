import type { Metric, MetricFilter } from './types';

export interface DimensionConfig {
  idExpr: string;           // SQL expr for the ID column, e.g. "d.current_manager_id::text"
  nameExpr?: string;        // SQL expr for name (optional, e.g. for product groups)
  extraJoins?: string;      // Additional JOINs
  groupBy: string;          // GROUP BY clause (must include funnel_id if funnelBreakdown=true)
  notNullWhere?: string;    // Extra WHERE condition
  funnelBreakdown?: boolean; // Add d.funnel_id to SELECT for pill filtering
}

function resolveFilterClause(f: MetricFilter, tableAlias: string): string {
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
    return `de.stage_id IN (SELECT id FROM stages WHERE event_type = '${f.value}')`;
  }
  if (f.field === 'stage_type') {
    return `${a}.stage_id IN (SELECT id FROM stages WHERE event_type = '${f.value}')`;
  }
  // is_null / is_not_null: special handling for product_rows (also check empty jsonb array)
  if (f.op === 'is_null') {
    if (f.field === 'products') {
      return `(${a}.products IS NULL OR jsonb_array_length(${a}.products) = 0)`;
    }
    return `${a}.${f.field} IS NULL`;
  }
  if (f.op === 'is_not_null') {
    return `${a}.${f.field} IS NOT NULL`;
  }

  const vals = Array.isArray(f.value)
    ? (f.value as (string | number)[]).map(v => typeof v === 'string' ? `'${v}'` : String(v)).join(', ')
    : null;

  switch (f.op) {
    case 'eq':      return `${a}.${f.field} = '${f.value}'`;
    case 'neq':     return `${a}.${f.field} != '${f.value}'`;
    case 'in':      return vals ? `${a}.${f.field} IN (${vals})` : '';
    case 'not_in':  return vals ? `${a}.${f.field} NOT IN (${vals})` : '';
    default: return '';
  }
}

function genDealsExpr(m: Metric): string {
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
  const dateFields = [...new Set(dealsM.map(m => m.dateField!))];
  const dateConds  = dateFields.map(f => `(d.${f} >= $1 AND d.${f} < $2)`);
  if (eventsM.length > 0) {
    const evtDateField = eventsM[0].dateField!;
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
