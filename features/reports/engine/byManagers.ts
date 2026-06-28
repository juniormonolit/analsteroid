import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, ReportRow } from '@/lib/metrics/types';
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

// ── Row cache (keyed by period + metrics, NOT pills) ──────────────────────
type FlatRow = Record<string, unknown> & { dimension_id: string; funnel_id: number };

const _rowCache = new Map<string, { rows: FlatRow[]; at: number }>();
const ROW_TTL = 10 * 60 * 1000; // 10 min

function mkKey(from: string, toExcl: string, metricIds: string[]): string {
  return `${from}|${toExcl}|${[...metricIds].sort().join(',')}`;
}

// ── Pill filter + aggregation ─────────────────────────────────────────────
// dealScope/clientType match the same funnel_id logic as sqlGen.ts:
//   primary/repeat ← funnels.is_repeat
//   b2c ← funnel_id IN (0, 2); b2b ← funnel_id IN (1, 3)
function aggregate(
  rows: FlatRow[],
  funnels: FunnelMeta[],
  metricIds: string[],
  dealScope: DealScope,
  clientType: ClientType,
): Map<string, Record<string, number>> {
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

  const agg = new Map<string, Record<string, number>>();
  for (const row of rows) {
    if (allowed !== null && !allowed.has(row.funnel_id)) continue;
    const dimId = row.dimension_id;
    if (!agg.has(dimId)) agg.set(dimId, Object.fromEntries(metricIds.map(id => [id, 0])));
    const entry = agg.get(dimId)!;
    for (const id of metricIds) {
      const v = row[id];
      if (v !== null && v !== undefined) entry[id] += Number(v);
    }
  }
  return agg;
}

// ── Public API ────────────────────────────────────────────────────────────
export interface ByManagersOptions {
  period: DateRange;
  dealScope?: DealScope;
  clientType?: ClientType;
  departmentIds?: string[];
  productGroupMode?: 'kc' | 'by_max'; // unused here, kept for API compat
}

export async function fetchByManagers(opts: ByManagersOptions): Promise<ReportRow[]> {
  const dealScope  = opts.dealScope  ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const deptIds    = opts.departmentIds ?? [];

  const fromIso   = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  const sysDb = systemDb();

  // Org hierarchy + dept filter run every request (fast, small tables)
  const [orgRes, deptRes] = await Promise.all([
    sysDb.query<{
      bitrix_user_id: string; manager_name: string;
      department_id: string | null; department_name: string | null;
      rop_bitrix_user_id: string | null; short_login: string | null;
    }>(`SELECT manager_bitrix_user_id AS bitrix_user_id,
              manager_name, department_id, department_name, rop_bitrix_user_id,
              short_login
         FROM org_resolved_hierarchy WHERE is_active = true`),
    deptIds.length
      ? sysDb.query<{ bitrix_user_id: string }>(
          `SELECT e.bitrix_user_id
             FROM employees e
             JOIN departments d ON d.id = e.department_id
            WHERE d.bitrix_department_id = ANY($1)`,
          [deptIds],
        )
      : Promise.resolve(null),
  ]);

  const orgMap         = new Map(orgRes.rows.map(r => [r.bitrix_user_id, r]));
  const allowedBitrix  = deptRes ? new Set(deptRes.rows.map(r => r.bitrix_user_id)) : null;

  // Metrics
  const allMetrics = await loadMetrics();
  const collected  = allMetrics.filter(m => m.metricType === 'collected' && !m.isTest);
  const metricIds  = collected.map(m => m.id);

  // Analytics row cache (pills are NOT part of the key)
  const key   = mkKey(fromIso, toExclIso, metricIds);
  let   entry = _rowCache.get(key);

  if (!entry || Date.now() - entry.at > ROW_TTL) {
    const sql = buildCollectedSQL(collected, {
      idExpr:          'd.current_manager_id::text',
      groupBy:         'GROUP BY d.current_manager_id, d.funnel_id',
      notNullWhere:    'd.current_manager_id IS NOT NULL',
      funnelBreakdown: true,
    });
    if (!sql) return [];

    const res = await analyticsDb().query<FlatRow>(sql, [fromIso, toExclIso]);
    entry = { rows: res.rows, at: Date.now() };
    _rowCache.set(key, entry);
  }

  // Apply pills in memory
  const funnels = await loadFunnels();
  const agg     = aggregate(entry.rows, funnels, metricIds, dealScope, clientType);

  // Map to ReportRow[]
  return [...agg.entries()]
    .filter(([id]) => !allowedBitrix || allowedBitrix.has(id))
    .map(([id, metrics]) => {
      const org = orgMap.get(id);
      return {
        dimensionId:       id,
        dimensionName:     org?.manager_name ?? `#${id}`,
        dimensionSubtitle: org?.short_login  ?? undefined,
        teamId:            org?.department_id   ?? null,
        teamName:          org?.department_name ?? null,
        metrics: Object.fromEntries(
          metricIds.map(mid => [mid, metrics[mid] !== undefined ? metrics[mid] : null]),
        ),
      };
    });
}
