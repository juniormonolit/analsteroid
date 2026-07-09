import { analyticsDb, systemDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { resolveSourceIds, sourceIdsWhere, resolveBranchManagerIds, managerIdsWhere, type SourceDimension } from '@/lib/marketing/sources';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, ReportRow, AccountType } from '@/lib/metrics/types';
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

function mkKey(from: string, toExcl: string, metricIds: string[], pgId?: string, srcKey?: string): string {
  return `${from}|${toExcl}|${pgId ?? 'all'}|${srcKey ?? 'all'}|${[...metricIds].sort().join(',')}`;
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
// резать не должна (баг: 107→12 на ППП, диагноз Маркуса 09.07); clientType (Б2Б/Б2С)
// по-прежнему применяется, т.к. это ортогональный срез.
function aggregate(
  rows: FlatRow[],
  funnels: FunnelMeta[],
  metricIds: string[],
  dealScope: DealScope,
  clientType: ClientType,
  scopeIndependentIds: Set<string>,
): Map<string, Record<string, number>> {
  const allowed          = computeAllowedFunnels(funnels, dealScope, clientType);
  const allowedScopeIndep = scopeIndependentIds.size > 0
    ? computeAllowedFunnels(funnels, 'all', clientType)
    : null;

  const agg = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const passesNormal     = allowed === null || allowed.has(row.funnel_id);
    const passesScopeIndep = allowedScopeIndep === null || allowedScopeIndep.has(row.funnel_id);
    if (!passesNormal && !passesScopeIndep) continue;

    const dimId = row.dimension_id;
    if (!agg.has(dimId)) agg.set(dimId, Object.fromEntries(metricIds.map(id => [id, 0])));
    const entry = agg.get(dimId)!;
    for (const id of metricIds) {
      const passes = scopeIndependentIds.has(id) ? passesScopeIndep : passesNormal;
      if (!passes) continue;
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
  accountType?: AccountType; // managers (bitrix_login manager*) / logists (logist*) / all
  productGroupMode?: 'kc' | 'by_max';
  productGroupId?: string; // drilldown: restrict to one product group
  // Маркетинговый дрилл-даун: ограничить сделками одного значения измерения источников
  sourceFilter?: { dimension: SourceDimension; value: string };
}

export async function fetchByManagers(opts: ByManagersOptions): Promise<ReportRow[]> {
  const dealScope  = opts.dealScope  ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const deptIds    = opts.departmentIds ?? [];
  const accountType = opts.accountType ?? 'all';
  const pgMode     = opts.productGroupMode ?? 'kc';
  const pgId       = opts.productGroupId;

  const fromIso   = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  // Marketing source filter (drilldown «Бренд → менеджеры» и т.п.)
  // «Филиал» — менеджерское измерение: фильтруем по менеджерам филиала, не по source_id.
  let srcWhere: string | undefined;
  let srcKey: string | undefined;
  if (opts.sourceFilter) {
    srcWhere = opts.sourceFilter.dimension === 'branch'
      ? managerIdsWhere(await resolveBranchManagerIds(opts.sourceFilter.value))
      : sourceIdsWhere(await resolveSourceIds(opts.sourceFilter.dimension, opts.sourceFilter.value));
    srcKey = `${opts.sourceFilter.dimension}=${opts.sourceFilter.value}`;
  }

  // Build product-group filter for drilldown (inlined into SQL like managerId in byProductGroups)
  let pgWhere: string | undefined;
  if (pgId !== undefined) {
    if (pgMode === 'kc') {
      if (pgId === '__none__') {
        pgWhere = 'd.product_group_id IS NULL';
      } else if (/^\d+$/.test(pgId)) {
        pgWhere = `d.product_group_id = ${pgId}`;
      }
    } else {
      // by_max: head_group_name is a string — escape single quotes (standard SQL literal escaping)
      if (pgId === 'Без группы') {
        pgWhere = 'd.head_group_name IS NULL';
      } else {
        pgWhere = `d.head_group_name = '${pgId.replace(/'/g, "''")}'`;
      }
    }
  }

  const sysDb = systemDb();

  // Org hierarchy + dept filter run every request (fast, small tables)
  const [orgRes, deptRes, loginRes] = await Promise.all([
    sysDb.query<{
      bitrix_user_id: string; manager_name: string;
      department_id: string | null; department_name: string | null;
      rop_bitrix_user_id: string | null; short_login: string | null;
      branch: string | null;
    }>(`SELECT manager_bitrix_user_id AS bitrix_user_id,
              manager_name, department_id, department_name, rop_bitrix_user_id,
              short_login, branch
         FROM org_resolved_hierarchy WHERE is_active = true`),
    deptIds.length
      ? sysDb.query<{ bitrix_user_id: string }>(
          `SELECT DISTINCT manager_bitrix_user_id::text AS bitrix_user_id
             FROM org_resolved_hierarchy orh
            WHERE orh.department_id IN (
              SELECT id FROM departments WHERE bitrix_department_id::text = ANY($1)
            )
              AND orh.is_active = true`,
          [deptIds],
        )
      : Promise.resolve(null),
    // Account-type filter is by the Bitrix login prefix (manager* / logist*), which lives in
    // employees.bitrix_login (NOT in org_resolved_hierarchy, where managers are short_login #NNNN).
    accountType !== 'all'
      ? sysDb.query<{ bitrix_user_id: string; bitrix_login: string | null }>(
          `SELECT bitrix_user_id::text AS bitrix_user_id, bitrix_login FROM employees WHERE is_active = true`,
        )
      : Promise.resolve(null),
  ]);

  const orgMap         = new Map(orgRes.rows.map(r => [r.bitrix_user_id, r]));
  const allowedBitrix  = deptRes ? new Set(deptRes.rows.map(r => r.bitrix_user_id)) : null;
  const loginByBitrix  = loginRes ? new Map(loginRes.rows.map(r => [r.bitrix_user_id, (r.bitrix_login ?? '').toLowerCase()])) : null;
  const accountPrefix  = accountType === 'managers' ? 'manager' : accountType === 'logists' ? 'logist' : null;

  // Metrics
  const allMetrics = await loadMetrics();
  const collected  = allMetrics.filter(m => m.metricType === 'collected' && !m.isTest);
  const metricIds  = collected.map(m => m.id);
  const scopeIndependentIds = new Set(
    collected.filter(m => m.tags.includes('scope_independent')).map(m => m.id),
  );

  // Analytics row cache (pills are NOT part of the key; pgId/srcKey ARE — they change the scope)
  // L1: in-memory Map, per-instance, 10 min. L2: Redis, shared across instances/restarts.
  const key   = mkKey(fromIso, toExclIso, metricIds, pgId, srcKey);
  let   entry = _rowCache.get(key);

  if (!entry || Date.now() - entry.at > ROW_TTL) {
    const rows = await cached(`rpt:mgr:${key}`, reportTtl(toExclIso), async () => {
      const notNullParts = ['d.current_manager_id IS NOT NULL'];
      if (pgWhere) notNullParts.push(pgWhere);
      if (srcWhere) notNullParts.push(srcWhere);
      const sql = buildCollectedSQL(collected, {
        idExpr:          'd.current_manager_id::text',
        groupBy:         'GROUP BY d.current_manager_id, d.funnel_id',
        notNullWhere:    notNullParts.join(' AND '),
        funnelBreakdown: true,
      });
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

  // Map to ReportRow[]
  return [...agg.entries()]
    .filter(([id]) => !allowedBitrix || allowedBitrix.has(id))
    .filter(([id]) => {
      if (!accountPrefix || !loginByBitrix) return true;
      return (loginByBitrix.get(id) ?? '').startsWith(accountPrefix);
    })
    .map(([id, metrics]) => {
      const org = orgMap.get(id);
      return {
        dimensionId:       id,
        dimensionName:     org?.manager_name ?? `#${id}`,
        dimensionSubtitle: org?.short_login  ?? undefined,
        teamId:            org?.department_id   ?? null,
        teamName:          org?.department_name ?? null,
        // Правило заказчика: всё, что не Москва и не Краснодар, — СПб. branch в
        // org_resolved_hierarchy заполнен для всех активных; фолбэк — для менеджеров
        // вне активной оргструктуры.
        branchName:        org?.branch ?? 'СПб',
        metrics: Object.fromEntries(
          metricIds.map(mid => [mid, metrics[mid] !== undefined ? metrics[mid] : null]),
        ),
      };
    });
}
