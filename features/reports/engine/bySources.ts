import { analyticsDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { fetchStageSnapshot, STAGE_SNAPSHOT_METRIC_IDS, DEALS_IN_WORK_METRIC_IDS } from './stageSnapshot';
import {
  loadSourceMap, dimensionValue, resolveSourceIds, sourceIdsWhere,
  loadManagerBranchMap, resolveBranchManagerIds, managerIdsWhere,
  NO_SOURCE_LABEL, UNDEFINED_LABEL, type SourceDimension,
} from '@/lib/marketing/sources';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, ReportRow, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';
import { createdTimeWhere, firstTouchWhere } from '@/lib/metrics/offHoursFilters';
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

// Снимок «Стадии (сейчас)» — период-независим, свой кэш (см. byManagers.ts).
const _snapshotCache = new Map<string, { snap: Awaited<ReturnType<typeof fetchStageSnapshot>>; at: number }>();
const SNAPSHOT_TTL = 2 * 60 * 1000;

function dimForGroupBy(groupBy: 'source' | 'manager', whereExtra: string | undefined) {
  return groupBy === 'source'
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
}

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

  const rows = await cached(`rpt:src:${key}`, reportTtl(toExclIso), async () => {
    const dim = dimForGroupBy(groupBy, whereExtra);
    const sql = buildCollectedSQL(collected, dim);
    if (!sql) return [];
    const res = await analyticsDb().query<FlatRow>(sql, [fromIso, toExclIso]);
    return res.rows;
  });
  _rowCache.set(key, { rows, at: Date.now() });
  return rows;
}

// Снимок «Стадии (сейчас)» — БЕЗ периода, отдельный кэш (см. byManagers.ts).
async function getSnapshot(
  groupBy: 'source' | 'manager',
  whereExtra: string | undefined,
  cacheSuffix: string,
): Promise<Awaited<ReturnType<typeof fetchStageSnapshot>>> {
  const key = `${groupBy}${cacheSuffix}`;
  const entry = _snapshotCache.get(key);
  if (entry && Date.now() - entry.at < SNAPSHOT_TTL) return entry.snap;
  const snap = await fetchStageSnapshot(dimForGroupBy(groupBy, whereExtra));
  _snapshotCache.set(key, { snap, at: Date.now() });
  return snap;
}

export interface BySourcesOptions {
  period: DateRange;
  dealScope?: DealScope;
  clientType?: ClientType;
  sourceDimension?: SourceDimension;
  // Дрилл-даун: ограничить сделками одного значения другого измерения
  sourceFilter?: { dimension: SourceDimension; value: string };
  // Задача 1569: экспериментальные фильтры по нерабочему времени (см.
  // lib/metrics/offHoursFilters.ts) — не funnel-based, идут прямо в SQL WHERE.
  createdTimeFilter?: CreatedTimeFilter;
  firstTouchFilter?: FirstTouchFilter;
}

export async function fetchBySources(opts: BySourcesOptions): Promise<ReportRow[]> {
  const dealScope  = opts.dealScope  ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const dim        = opts.sourceDimension ?? 'brand';
  const filter     = opts.sourceFilter;
  const isBranchDim = dim === 'branch';
  const createdTimeFilter = opts.createdTimeFilter ?? 'all';
  const firstTouchFilter  = opts.firstTouchFilter  ?? 'all';

  const fromIso   = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  const allMetrics = await loadMetrics();
  const collected  = allMetrics.filter(m => m.metricType === 'collected' && !m.isTest);
  const metricIds  = collected.map(m => m.id);
  // ППП/ППО/ППБ/ПППБ (тег 'scope_independent') — про историю клиента, а не воронку
  // сделки в периоде; пилюля «Первичные/Повторные» их резать не должна (тот же баг,
  // что в byManagers/byProductGroups, диагноз Маркуса 09.07). clientType (Б2Б/Б2С)
  // по-прежнему применяется.
  const scopeIndependentIds = new Set(
    collected.filter(m => m.tags.includes('scope_independent')).map(m => m.id),
  );

  // Фильтр противоположного типа → SQL WHERE (+ ключ кэша)
  const whereParts: string[] = [];
  let cacheSuffix = '';
  if (filter) {
    if (filter.dimension === 'branch') {
      // дрилл из филиала: режем по менеджерам филиала
      whereParts.push(managerIdsWhere(await resolveBranchManagerIds(filter.value)));
      cacheSuffix = `|mgr:${filter.value}`;
    } else if (isBranchDim) {
      // дрилл в филиалы из source-сущности: режем по source_id
      const ids = await resolveSourceIds(filter.dimension, filter.value);
      whereParts.push(sourceIdsWhere(ids));
      cacheSuffix = `|src:${filter.dimension}=${filter.value}`;
    }
    // source-измерение + source-фильтр → в памяти, SQL не трогаем
  }
  // Задача 1569: фильтры по нерабочему времени — не funnel-based, идут в SQL WHERE
  // (как фильтр противоположного типа выше), а не в постфактум-фильтр по funnel_id.
  const offhWhereStr = [createdTimeWhere('d', createdTimeFilter), firstTouchWhere('d', firstTouchFilter)]
    .filter(Boolean).join(' AND ');
  if (offhWhereStr) whereParts.push(offhWhereStr);
  cacheSuffix += `|offh:${createdTimeFilter}:${firstTouchFilter}`;
  const whereExtra = whereParts.length > 0 ? whereParts.join(' AND ') : undefined;

  const rows = await getRows(isBranchDim ? 'manager' : 'source', fromIso, toExclIso, whereExtra, cacheSuffix);
  // Снимок «Стадии (сейчас)» (задача 2059) — БЕЗ периода, отдельный кэш.
  const snap = await getSnapshot(isBranchDim ? 'manager' : 'source', whereExtra, cacheSuffix);
  const { pillRows, workByDim } = snap;
  const allRows      = [...rows, ...pillRows] as FlatRow[];
  const allMetricIds = [...metricIds, ...STAGE_SNAPSHOT_METRIC_IDS];

  const [funnels, sourceMap, mgrBranch] = await Promise.all([
    loadFunnels(),
    loadSourceMap(),
    isBranchDim ? loadManagerBranchMap() : Promise.resolve(null),
  ]);

  // Funnel-пилюли
  function computeAllowedFunnels(scope: DealScope, client: ClientType): Set<number> | null {
    if (scope === 'all' && client === 'all') return null;
    return new Set<number>(
      funnels
        .filter(f => {
          const scopeOk  = scope === 'all' || (scope === 'primary' ? !f.isRepeat : f.isRepeat);
          const clientOk = client === 'all' || (client === 'b2c' ? [0, 2].includes(f.id) : [1, 3].includes(f.id));
          return scopeOk && clientOk;
        })
        .map(f => f.id),
    );
  }
  const allowedFunnels = computeAllowedFunnels(dealScope, clientType);
  const allowedFunnelsScopeIndep = scopeIndependentIds.size > 0
    ? computeAllowedFunnels('all', clientType)
    : null;

  // In-memory фильтр по source_id (source-измерение + source-фильтр)
  let allowedIds: Set<string> | 'null' | null = null;
  if (filter && !isBranchDim && filter.dimension !== 'branch') {
    const ids = await resolveSourceIds(filter.dimension, filter.value);
    allowedIds = ids === 'null' ? 'null' : new Set(ids);
  }

  // Резолвинг raw dimension_id → финальный groupId (та же логика, что и в основном
  // цикле ниже) — переиспользуется отдельно для «Сделок в работе» (workByDim), у
  // которой своя, НЕ funnel-пилюльная агрегация (см. stageSnapshot.ts).
  function resolveGroupId(rid: string): string | null {
    if (isBranchDim) {
      return rid === '__null__' ? UNDEFINED_LABEL : (mgrBranch!.get(rid) ?? UNDEFINED_LABEL);
    }
    if (allowedIds !== null) {
      if (allowedIds === 'null') { if (rid !== '__null__') return null; }
      else if (!allowedIds.has(rid)) return null;
    }
    if (rid === '__null__') return '__null__';
    if (dim === 'source') return rid;
    return dimensionValue(sourceMap.get(rid), dim);
  }

  // Агрегация по значению измерения
  const agg = new Map<string, { name: string; metrics: Record<string, number> }>();
  for (const row of allRows) {
    const passesNormal     = allowedFunnels === null || allowedFunnels.has(row.funnel_id);
    const passesScopeIndep = allowedFunnelsScopeIndep === null || allowedFunnelsScopeIndep.has(row.funnel_id);
    if (!passesNormal && !passesScopeIndep) continue;
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
      agg.set(groupId, { name: groupName, metrics: Object.fromEntries(allMetricIds.map(id => [id, 0])) });
    }
    const e = agg.get(groupId)!;
    for (const id of allMetricIds) {
      const passes = scopeIndependentIds.has(id) ? passesScopeIndep : passesNormal;
      if (!passes) continue;
      const v = row[id];
      if (v !== null && v !== undefined) e.metrics[id] += Number(v);
    }
  }

  // «Сделок в работе» (перв./повт./все) — НЕ funnel-пилюльная (см. stageSnapshot.ts),
  // агрегируется по ТЕМ ЖЕ groupId, что и остальные метрики выше (resolveGroupId).
  const workAgg = new Map<string, { primary: number; repeat: number; all: number }>();
  for (const [rid, w] of workByDim) {
    const groupId = resolveGroupId(rid);
    if (groupId === null || !agg.has(groupId)) continue;
    let acc = workAgg.get(groupId);
    if (!acc) { acc = { primary: 0, repeat: 0, all: 0 }; workAgg.set(groupId, acc); }
    acc.primary += w.primary; acc.repeat += w.repeat; acc.all += w.all;
  }

  return [...agg.entries()].map(([id, { name, metrics }]) => {
    const work = workAgg.get(id);
    return {
      dimensionId:   id,
      dimensionName: name,
      teamId:        null,
      teamName:      null,
      metrics: {
        ...Object.fromEntries(
          allMetricIds.map(mid => [mid, metrics[mid] !== undefined ? metrics[mid] : null]),
        ),
        [DEALS_IN_WORK_METRIC_IDS[0]]: work ? work.primary : 0,
        [DEALS_IN_WORK_METRIC_IDS[1]]: work ? work.repeat  : 0,
        [DEALS_IN_WORK_METRIC_IDS[2]]: work ? work.all     : 0,
      },
    };
  });
}
