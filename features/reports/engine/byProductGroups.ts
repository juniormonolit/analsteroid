import { analyticsDb } from '@/lib/db/clients';
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

function mkKey(from: string, toExcl: string, metricIds: string[], mode: string): string {
  return `${from}|${toExcl}|${mode}|${[...metricIds].sort().join(',')}`;
}

// ── Pill filter + aggregation ─────────────────────────────────────────────
function aggregate(
  rows: FlatRow[],
  funnels: FunnelMeta[],
  metricIds: string[],
  dealScope: DealScope,
  clientType: ClientType,
): Map<string, { name: string; metrics: Record<string, number> }> {
  const skipFilter = dealScope === 'all' && clientType === 'all';

  const allowed = skipFilter
    ? null
    : new Set<number>(
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

  const agg = new Map<string, { name: string; metrics: Record<string, number> }>();
  for (const row of rows) {
    if (allowed !== null && !allowed.has(row.funnel_id)) continue;
    const dimId   = row.dimension_id as string;
    const dimName = (row.dimension_name as string | undefined) ?? dimId;
    if (!agg.has(dimId)) {
      agg.set(dimId, { name: dimName, metrics: Object.fromEntries(metricIds.map(id => [id, 0])) });
    }
    const entry = agg.get(dimId)!;
    for (const id of metricIds) {
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
}

export async function fetchByProductGroups(opts: ByProductGroupsOptions): Promise<ReportRow[]> {
  const dealScope  = opts.dealScope  ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const mode       = opts.productGroupMode ?? 'kc';

  const fromIso   = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  const allMetrics = await loadMetrics();
  const collected  = allMetrics.filter(m => m.metricType === 'collected' && !m.isTest);
  const metricIds  = collected.map(m => m.id);

  // Analytics row cache (pills NOT in key; mode IS in key — it changes the dimension)
  const key   = mkKey(fromIso, toExclIso, metricIds, mode);
  let   entry = _rowCache.get(key);

  if (!entry || Date.now() - entry.at > ROW_TTL) {
    const dim = mode === 'by_max'
      ? {
          idExpr:          `COALESCE(d.head_group_name, 'Без группы')`,
          nameExpr:        `COALESCE(d.head_group_name, 'Без группы')`,
          groupBy:         'GROUP BY d.head_group_name, d.funnel_id',
          funnelBreakdown: true as const,
        }
      : {
          idExpr:          `COALESCE(d.product_group_id::text, '__none__')`,
          nameExpr:        `COALESCE(pg.name, 'Без группы')`,
          extraJoins:      'LEFT JOIN product_groups pg ON pg.id = d.product_group_id',
          groupBy:         'GROUP BY d.product_group_id, pg.name, d.funnel_id',
          funnelBreakdown: true as const,
        };

    const sql = buildCollectedSQL(collected, dim);
    if (!sql) return [];

    const res = await analyticsDb().query<FlatRow>(sql, [fromIso, toExclIso]);
    entry = { rows: res.rows, at: Date.now() };
    _rowCache.set(key, entry);
  }

  // Apply pills in memory
  const funnels = await loadFunnels();
  const agg     = aggregate(entry.rows, funnels, metricIds, dealScope, clientType);

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
