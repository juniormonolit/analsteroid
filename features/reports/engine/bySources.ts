import { analyticsDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { fetchStageSnapshot, STAGE_SNAPSHOT_METRIC_IDS, DEALS_IN_WORK_METRIC_IDS } from './stageSnapshot';
import {
  loadSourceMap, loadDimensionResolver, resolveSourceIds, sourceIdsWhere, sourceIdMatcher,
  loadManagerBranchMap, loadManagerInfoMap, resolveBranchManagerIds, managerIdsWhere,
  resolveDeptManagerIds, resolveTeamManagerIds, SOURCE_TEAM_SEP,
  NO_SOURCE_LABEL, UNDEFINED_LABEL, type SourceDimension,
} from '@/lib/marketing/sources';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, ReportRow, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';
import { createdTimeWhere, firstTouchWhere } from '@/lib/metrics/offHoursFilters';
import { buildDealFilterWhere, type DealFilter } from '@/lib/metrics/dealFilters';
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

// 'source_manager' — разбивка по отделам (группировка «По отделам/филиалам» маркетинговых
// отчётов): строка = пара «source_id | менеджер сделки», отдел берётся по менеджеру.
type GroupBy = 'source' | 'manager' | 'source_manager';

function dimForGroupBy(groupBy: GroupBy, whereExtra: string | undefined) {
  if (groupBy === 'source_manager') {
    return {
      idExpr:          `COALESCE(d.source_id, '__null__') || '|' || COALESCE(d.current_manager_id::text, '__null__')`,
      groupBy:         'GROUP BY d.source_id, d.current_manager_id, d.funnel_id',
      notNullWhere:    whereExtra,
      funnelBreakdown: true as const,
    };
  }
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
  groupBy: GroupBy,
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
  groupBy: GroupBy,
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
  /** «Фильтр сделок» (задача 07.08): режет сам набор сделок отчёта. */
  dealFilters?: DealFilter[];
  /** Фильтр «Отделы» (bitrix_department_id) — сделки менеджеров этих отделов (владелец 27.10). */
  departmentIds?: string[];
  /** Один отдел по uuid — дрилл строки «значение × отдел» (см. splitByTeam). */
  teamId?: string;
  /**
   * Группировка «По отделам/филиалам» (владелец 27.10: «как в основных отчётах»): строка —
   * пара «значение измерения × отдел менеджера сделки», id `${value}@@${teamId}`, с
   * teamId/teamName/branchName — дальше клиент группирует её тем же applyClientGrouping.
   */
  splitByTeam?: boolean;
}

export async function fetchBySources(opts: BySourcesOptions): Promise<ReportRow[]> {
  const dealScope  = opts.dealScope  ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const dim        = opts.sourceDimension ?? 'brand';
  const filter     = opts.sourceFilter;
  const isBranchDim = dim === 'branch';
  const split      = !!opts.splitByTeam;
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
  // Отделы: фильтр отчёта и/или один отдел строки дрилла — по менеджеру сделки, в SQL.
  const deptIds = [...(opts.departmentIds ?? [])].sort();
  if (deptIds.length > 0) {
    whereParts.push(managerIdsWhere(await resolveDeptManagerIds(deptIds)));
    cacheSuffix += `|depts:${deptIds.join(',')}`;
  }
  if (opts.teamId) {
    whereParts.push(managerIdsWhere(await resolveTeamManagerIds(opts.teamId)));
    cacheSuffix += `|team:${opts.teamId}`;
  }
  // Задача 1569: фильтры по нерабочему времени — не funnel-based, идут в SQL WHERE
  // (как фильтр противоположного типа выше), а не в постфактум-фильтр по funnel_id.
  // «Фильтр сделок» (задача 07.08) — той же дорогой: режет сделки, значит в
  // WHERE и в ключ кэша.
  const df = buildDealFilterWhere(opts.dealFilters);
  const offhWhereStr = [createdTimeWhere('d', createdTimeFilter), firstTouchWhere('d', firstTouchFilter), df.sql]
    .filter(Boolean).join(' AND ');
  if (offhWhereStr) whereParts.push(offhWhereStr);
  cacheSuffix += `|offh:${createdTimeFilter}:${firstTouchFilter}|df:${df.key}`;
  const whereExtra = whereParts.length > 0 ? whereParts.join(' AND ') : undefined;

  // «Филиал» — менеджерское измерение: строки уже по менеджеру, отдел виден и так.
  const groupBy: GroupBy = isBranchDim ? 'manager' : split ? 'source_manager' : 'source';
  const rows = await getRows(groupBy, fromIso, toExclIso, whereExtra, cacheSuffix);
  // Снимок «Стадии (сейчас)» (задача 2059) — БЕЗ периода, отдельный кэш.
  const snap = await getSnapshot(groupBy, whereExtra, cacheSuffix);
  const { pillRows, workByDim } = snap;
  const allRows      = [...rows, ...pillRows] as FlatRow[];
  const allMetricIds = [...metricIds, ...STAGE_SNAPSHOT_METRIC_IDS];

  const [funnels, sourceMap, mgrBranch, dimResolve, mgrInfo] = await Promise.all([
    loadFunnels(),
    loadSourceMap(),
    isBranchDim ? loadManagerBranchMap() : Promise.resolve(null),
    // Встроенные измерения и группировки «Ещё → Источники» (`g:<id>`) — одним резолвером.
    isBranchDim || dim === 'source' ? Promise.resolve(null) : loadDimensionResolver(dim as Exclude<SourceDimension, 'branch'>),
    split ? loadManagerInfoMap() : Promise.resolve(null),
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
  let allowed: ((rid: string) => boolean) | null = null;
  if (filter && !isBranchDim && filter.dimension !== 'branch') {
    allowed = sourceIdMatcher(await resolveSourceIds(filter.dimension, filter.value));
  }

  // raw dimension_id → { источник/менеджер, менеджер для отдела }
  function parseRid(rid: string): { src: string; mgr: string | null } {
    if (isBranchDim) return { src: rid, mgr: rid };
    if (groupBy !== 'source_manager') return { src: rid, mgr: null };
    const i = rid.lastIndexOf('|');
    return { src: rid.slice(0, i), mgr: rid.slice(i + 1) };
  }
  type Team = { id: string; name: string; branch: string | null };
  function teamOf(mgr: string | null): Team | null {
    if (!split) return null;
    const info = mgr && mgr !== '__null__' ? mgrInfo!.get(mgr) : undefined;
    return info?.departmentId
      ? { id: info.departmentId, name: info.department ?? 'Без отдела', branch: info.branch }
      : { id: '__no_team__', name: 'Без отдела', branch: info?.branch ?? null };
  }

  // Резолвинг raw dimension_id → { groupId, groupName } (одна логика для метрик и для
  // «Сделок в работе» — workByDim, у которой своя, НЕ funnel-пилюльная агрегация).
  function resolveGroup(rid: string): { id: string; name: string; team: Team | null } | null {
    const { src, mgr } = parseRid(rid);
    const team = teamOf(mgr);
    let id: string, name: string;
    if (isBranchDim) {
      name = src === '__null__' ? UNDEFINED_LABEL : (mgrBranch!.get(src) ?? UNDEFINED_LABEL);
      id = name;
    } else {
      if (allowed !== null && !allowed(src)) return null;
      if (src === '__null__') { id = '__null__'; name = NO_SOURCE_LABEL; }
      else if (dim === 'source') { id = src; name = sourceMap.get(src)?.name || `#${src}`; }
      else { name = dimResolve!(src); id = name; }
    }
    return { id: team ? `${id}${SOURCE_TEAM_SEP}${team.id}` : id, name, team };
  }

  // Агрегация по значению измерения (× отдел при splitByTeam)
  const agg = new Map<string, { name: string; team: Team | null; metrics: Record<string, number> }>();
  for (const row of allRows) {
    const passesNormal     = allowedFunnels === null || allowedFunnels.has(row.funnel_id);
    const passesScopeIndep = allowedFunnelsScopeIndep === null || allowedFunnelsScopeIndep.has(row.funnel_id);
    if (!passesNormal && !passesScopeIndep) continue;
    const g = resolveGroup(row.dimension_id);
    if (!g) continue;

    if (!agg.has(g.id)) {
      agg.set(g.id, { name: g.name, team: g.team, metrics: Object.fromEntries(allMetricIds.map(id => [id, 0])) });
    }
    const e = agg.get(g.id)!;
    for (const id of allMetricIds) {
      const passes = scopeIndependentIds.has(id) ? passesScopeIndep : passesNormal;
      if (!passes) continue;
      const v = row[id];
      if (v !== null && v !== undefined) e.metrics[id] += Number(v);
    }
  }

  // «Сделок в работе» (перв./повт./все) — НЕ funnel-пилюльная (см. stageSnapshot.ts),
  // агрегируется по ТЕМ ЖЕ groupId, что и остальные метрики выше.
  const workAgg = new Map<string, { primary: number; repeat: number; all: number }>();
  for (const [rid, w] of workByDim) {
    const g = resolveGroup(rid);
    if (!g || !agg.has(g.id)) continue;
    let acc = workAgg.get(g.id);
    if (!acc) { acc = { primary: 0, repeat: 0, all: 0 }; workAgg.set(g.id, acc); }
    acc.primary += w.primary; acc.repeat += w.repeat; acc.all += w.all;
  }

  return [...agg.entries()].map(([id, { name, team, metrics }]) => {
    const work = workAgg.get(id);
    return {
      dimensionId:   id,
      dimensionName: name,
      teamId:        team?.id ?? null,
      teamName:      team?.name ?? null,
      ...(team ? { branchName: team.branch } : {}),
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
