import { analyticsDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import {
  loadSourceMap, dimensionValue, resolveSourceIds, sourceIdsWhere,
  loadManagerBranchMap, resolveBranchManagerIds, managerIdsWhere,
  NO_SOURCE_LABEL, UNDEFINED_LABEL, type SourceDimension,
} from '@/lib/marketing/sources';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, ReportRow } from '@/lib/metrics/types';
import { addDays, startOfDay } from 'date-fns';

// ── Funnel metadata (та же схема, что в byManagers/byProductGroups) ─────────
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

// ── Row cache ────────────────────────────────────────────────────────────────
// Для source-измерений строки — (source_id, funnel_id); для «Филиал» (по менеджеру
// сделки) — (manager_id, funnel_id). Дрилл-фильтры противоположного типа уходят
// в SQL WHERE и в ключ кэша; фильтры своего типа применяются в памяти.
type FlatRow = Record<string, unknown> & { dimension_id: string; funnel_id: number };

const _rowCache = new Map<string, { rows: FlatRow[]; at: number }>();
const ROW_TTL = 10 * 60 * 1000;

async function getRows(
  groupBy: 'source' | 'manager',
  fromIso: string,
  toExclIso: string,
  whereExtra: string | undefined,
  cacheSuffix: string,
): Promise<FlatRow[]> {
  const allMetrics = await loadMetrics();
  const collected  = allMetrics.filter(m => m.metricType === 'collected' && !m.isTest);
  if (collected.length === 0) return [];

  const key = `${groupBy}|${fromIso}|${toExclIso}${cacheSuffix}|${collected.map(m => m.id).sort().join(',')}`;
  const entry = _rowCache.get(key);
  if (entry && Date.now() - entry.at < ROW_TTL) return entry.rows;

  const dim = groupBy === 'source'
    ? {
        idExpr:          `COALESCE(d.source_id, '__null__')`,
        groupBy:         'GROUP BY d.source_id, d.funnel_id',
        notNullWhere:    whereExtra,
        funnelBreakdown: true as const,
      }
    : {
        idExpr:          `COALESCE(d.current_manager_id::text, '__null__')`,
        groupBy:         'GROUP BY d.current_manager_id, d.funnel_id',
        notNullWhere:    whereExtra,
        funnelBreakdown: true as const,
      };

  const sql = buildCollectedSQL(collected, dim);
  if (!sql) return [];
  const res = await analyticsDb().query<FlatRow>(sql, [fromIso, toExclIso]);
  _rowCache.set(key, { rows: res.rows, at: Date.now() });
  return res.rows;
}

export interface BySourcesOptions {
  period: DateRange;
  dealScope?: DealScope;
  clientType?: ClientType;
  sourceDimension?: SourceDimension;
  // Дрилл-даун: ограничить сделками одного значения другого измерения
  sourceFilter?: { dimension: SourceDimension; value: string };
}

export async function fetchBySources(opts: BySourcesOptions): Promise<ReportRow[]> {
  const dealScope  = opts.dealScope  ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const dim        = opts.sourceDimension ?? 'brand';
  const filter     = opts.sourceFilter;
  const isBranchDim = dim === 'branch';

  const fromIso   = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  const allMetrics = await loadMetrics();
  const metricIds  = allMetrics.filter(m => m.metricType === 'collected' && !m.isTest).map(m => m.id);

  // Фильтр противоположного типа → SQL WHERE (+ ключ кэша)
  let whereExtra: string | undefined;
  let cacheSuffix = '';
  if (filter) {
    if (filter.dimension === 'branch') {
      // дрилл из филиала: режем по менеджерам филиала
      whereExtra = managerIdsWhere(await resolveBranchManagerIds(filter.value));
      cacheSuffix = `|mgr:${filter.value}`;
    } else if (isBranchDim) {
      // дрилл в филиалы из source-сущности: режем по source_id
      const ids = await resolveSourceIds(filter.dimension, filter.value);
      whereExtra = sourceIdsWhere(ids);
      cacheSuffix = `|src:${filter.dimension}=${filter.value}`;
    }
    // source-измерение + source-фильтр → в памяти, SQL не трогаем
  }

  const rows = await getRows(isBranchDim ? 'manager' : 'source', fromIso, toExclIso, whereExtra, cacheSuffix);

  const [funnels, sourceMap, mgrBranch] = await Promise.all([
    loadFunnels(),
    loadSourceMap(),
    isBranchDim ? loadManagerBranchMap() : Promise.resolve(null),
  ]);

  // Funnel-пилюли
  const skipFunnel = dealScope === 'all' && clientType === 'all';
  const allowedFunnels = skipFunnel
    ? null
    : new Set<number>(
        funnels
          .filter(f => {
            const scopeOk  = dealScope === 'all' || (dealScope === 'primary' ? !f.isRepeat : f.isRepeat);
            const clientOk = clientType === 'all' || (clientType === 'b2c' ? [0, 2].includes(f.id) : [1, 3].includes(f.id));
            return scopeOk && clientOk;
          })
          .map(f => f.id),
      );

  // In-memory фильтр по source_id (source-измерение + source-фильтр)
  let allowedIds: Set<string> | 'null' | null = null;
  if (filter && !isBranchDim && filter.dimension !== 'branch') {
    const ids = await resolveSourceIds(filter.dimension, filter.value);
    allowedIds = ids === 'null' ? 'null' : new Set(ids);
  }

  // Агрегация по значению измерения
  const agg = new Map<string, { name: string; metrics: Record<string, number> }>();
  for (const row of rows) {
    if (allowedFunnels !== null && !allowedFunnels.has(row.funnel_id)) continue;
    const rid = row.dimension_id;
    let groupId: string, groupName: string;

    if (isBranchDim) {
      // rid = manager_id → филиал менеджера
      groupName = rid === '__null__' ? UNDEFINED_LABEL : (mgrBranch!.get(rid) ?? UNDEFINED_LABEL);
      groupId = groupName;
    } else {
      if (allowedIds !== null) {
        if (allowedIds === 'null') { if (rid !== '__null__') continue; }
        else if (!allowedIds.has(rid)) continue;
      }
      if (rid === '__null__') {
        groupId = '__null__'; groupName = NO_SOURCE_LABEL;
      } else if (dim === 'source') {
        const info = sourceMap.get(rid);
        groupId = rid; groupName = info?.name || `#${rid}`;
      } else {
        groupName = dimensionValue(sourceMap.get(rid), dim);
        groupId = groupName;
      }
    }

    if (!agg.has(groupId)) {
      agg.set(groupId, { name: groupName, metrics: Object.fromEntries(metricIds.map(id => [id, 0])) });
    }
    const e = agg.get(groupId)!;
    for (const id of metricIds) {
      const v = row[id];
      if (v !== null && v !== undefined) e.metrics[id] += Number(v);
    }
  }

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
