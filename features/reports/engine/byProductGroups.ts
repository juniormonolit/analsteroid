import { analyticsDb, systemDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, ReportRow, ProductGroupMode } from '@/lib/metrics/types';
import { addDays, startOfDay } from 'date-fns';

// ── Funnel metadata ───────────────────────────────────────────────────────
interface FunnelMeta { id: number; isRepeat: boolean }
let _funnels: FunnelMeta[] | null = null;
let _funnelsAt = 0;

async function loadFunnels(): Promise<FunnelMeta[]> {
  if (_funnels && Date.now() - _funnelsAt < 30 * 60 * 1000) return _funnels;
  const res = await analyticsDb().query<{ id: number; is_repeat: boolean }>(
    'SELECT id, is_repeat FROM funnels',
  );
  _funnels = res.rows.map(r => ({ id: r.id, isRepeat: r.is_repeat }));
  _funnelsAt = Date.now();
  return _funnels;
}

// ── Row cache (keyed by period + metrics + mode, NOT pills) ───────────────
type FlatRow = Record<string, unknown> & { dimension_id: string; funnel_id: number };

const _rowCache = new Map<string, { rows: FlatRow[]; at: number }>();
const ROW_TTL = 10 * 60 * 1000; // 10 min

function mkKey(from: string, toExcl: string, metricIds: string[], mode: string, managerId?: string, deptKey?: string): string {
  return `${from}|${toExcl}|${mode}|${managerId ?? 'all'}|${deptKey ?? 'all'}|${[...metricIds].sort().join(',')}`;
}

// dealScope/clientType match the same funnel_id logic as sqlGen.ts:
//   primary/repeat ← funnels.is_repeat
//   b2c ← funnel_id IN (0, 2); b2b ← funnel_id IN (1, 3)
function computeAllowedFunnels(
  funnels: FunnelMeta[],
  dealScope: DealScope,
  clientType: ClientType,
): Set<number> | null {
  if (dealScope === 'all' && clientType === 'all') return null;
  return new Set<number>(
    funnels
      .filter(f => {
        const scopeOk =
          dealScope === 'all' ||
          (dealScope === 'primary' ? !f.isRepeat : f.isRepeat);
        const clientOk =
          clientType === 'all' ||
          (clientType === 'b2c' ? [0, 2].includes(f.id) : [1, 3].includes(f.id));
        return scopeOk && clientOk;
      })
      .map(f => f.id),
  );
}

// ── Pill filter + aggregation ─────────────────────────────────────────────
// Метрики из scopeIndependentIds (ППП/ППО/ППБ/ПППБ — тег 'scope_independent' в metrics.tags)
// считают "N-ю сделку клиента за всю историю" — они про историю клиента, а не про
// воронку сделки, попавшей в период. Пилюля «Первичные/Повторные» (dealScope) их
// резать не должна (тот же баг, что в byManagers.ts, диагноз Маркуса 09.07);
// clientType (Б2Б/Б2С) по-прежнему применяется, т.к. это ортогональный срез.
function aggregate(
  rows: FlatRow[],
  funnels: FunnelMeta[],
  metricIds: string[],
  dealScope: DealScope,
  clientType: ClientType,
  scopeIndependentIds: Set<string>,
): Map<string, { name: string; metrics: Record<string, number> }> {
  const allowed          = computeAllowedFunnels(funnels, dealScope, clientType);
  const allowedScopeIndep = scopeIndependentIds.size > 0
    ? computeAllowedFunnels(funnels, 'all', clientType)
    : null;

  const agg = new Map<string, { name: string; metrics: Record<string, number> }>();
  for (const row of rows) {
    const passesNormal     = allowed === null || allowed.has(row.funnel_id);
    const passesScopeIndep = allowedScopeIndep === null || allowedScopeIndep.has(row.funnel_id);
    if (!passesNormal && !passesScopeIndep) continue;

    const dimId   = row.dimension_id as string;
    const dimName = (row.dimension_name as string | undefined) ?? dimId;
    if (!agg.has(dimId)) {
      agg.set(dimId, { name: dimName, metrics: Object.fromEntries(metricIds.map(id => [id, 0])) });
    }
    const entry = agg.get(dimId)!;
    for (const id of metricIds) {
      const passes = scopeIndependentIds.has(id) ? passesScopeIndep : passesNormal;
      if (!passes) continue;
      const v = row[id];
      if (v !== null && v !== undefined) entry.metrics[id] += Number(v);
    }
  }
  return agg;
}

// ── Public API ────────────────────────────────────────────────────────────
export interface ByProductGroupsOptions {
  period: DateRange;
  dealScope?: DealScope;
  clientType?: ClientType;
  productGroupMode?: ProductGroupMode;
  managerId?: string;      // drilldown: restrict to one manager's deals
  departmentIds?: string[]; // filter to deals by managers in selected departments
}

export async function fetchByProductGroups(opts: ByProductGroupsOptions): Promise<ReportRow[]> {
  const dealScope  = opts.dealScope  ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const mode       = opts.productGroupMode ?? 'kc';
  const deptIds    = opts.departmentIds ?? [];
  // managerId / deptIds come from the request — validate numeric IDs before inlining into SQL.
  const managerId  = opts.managerId && /^\d+$/.test(opts.managerId) ? opts.managerId : undefined;

  const fromIso   = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  // Resolve department filter → allowed manager IDs (then inline into SQL)
  let deptManagerWhere: string | undefined;
  const deptKey = deptIds.length ? [...deptIds].sort().join(',') : undefined;
  if (deptIds.length > 0) {
    const res = await systemDb().query<{ bitrix_user_id: string }>(
      `SELECT DISTINCT manager_bitrix_user_id::text AS bitrix_user_id
         FROM org_resolved_hierarchy orh
        WHERE orh.department_id IN (
          SELECT id FROM departments WHERE bitrix_department_id::text = ANY($1)
        )
          AND orh.is_active = true`,
      [deptIds],
    );
    const ids = res.rows.map(r => r.bitrix_user_id).filter(id => /^\d+$/.test(id));
    // If dept has no managers, return nothing rather than ignoring the filter
    deptManagerWhere = ids.length > 0 ? `d.current_manager_id IN (${ids.join(',')})` : '1=0';
  }

  // Combine WHERE conditions (managerId for drilldown, deptManagerWhere for dept filter)
  const whereParts: string[] = [];
  if (managerId) whereParts.push(`d.current_manager_id = ${managerId}`);
  if (deptManagerWhere) whereParts.push(deptManagerWhere);
  const notNullWhere = whereParts.length > 0 ? whereParts.join(' AND ') : undefined;

  const allMetrics = await loadMetrics();
  const collected  = allMetrics.filter(m => m.metricType === 'collected' && !m.isTest);
  const metricIds  = collected.map(m => m.id);
  const scopeIndependentIds = new Set(
    collected.filter(m => m.tags.includes('scope_independent')).map(m => m.id),
  );

  // Analytics row cache (pills NOT in key; mode + managerId + deptKey ARE — they change the scope)
  const key   = mkKey(fromIso, toExclIso, metricIds, mode, managerId, deptKey);
  let   entry = _rowCache.get(key);

  if (!entry || Date.now() - entry.at > ROW_TTL) {
    const rows = await cached(`rpt:pg:${key}`, reportTtl(toExclIso), async () => {
      const dim = mode === 'by_max'
        ? {
            idExpr:          `COALESCE(d.head_group_name, 'Без группы')`,
            nameExpr:        `COALESCE(d.head_group_name, 'Без группы')`,
            groupBy:         'GROUP BY d.head_group_name, d.funnel_id',
            notNullWhere,
            funnelBreakdown: true as const,
          }
        : {
            idExpr:          `COALESCE(d.product_group_id::text, '__none__')`,
            nameExpr:        `COALESCE(pg.name, 'Без группы')`,
            extraJoins:      'LEFT JOIN product_groups pg ON pg.id = d.product_group_id',
            groupBy:         'GROUP BY d.product_group_id, pg.name, d.funnel_id',
            notNullWhere,
            funnelBreakdown: true as const,
          };

      const sql = buildCollectedSQL(collected, dim);
      if (!sql) return [];
      const res = await analyticsDb().query<FlatRow>(sql, [fromIso, toExclIso]);
      return res.rows;
    });
    entry = { rows, at: Date.now() };
    _rowCache.set(key, entry);
  }

  // Apply pills in memory
  const funnels = await loadFunnels();
  const agg     = aggregate(entry.rows, funnels, metricIds, dealScope, clientType, scopeIndependentIds);

  return [...agg.entries()].map(([id, { name, metrics }]) => ({
    dimensionId:   id,
    dimensionName: name,
    teamId:        null,
    teamName:      null,
    metrics: Object.fromEntries(
      metricIds.map(mid => [mid, metrics[mid] !== undefined ? metrics[mid] : null]),
    ),
  }));
}
