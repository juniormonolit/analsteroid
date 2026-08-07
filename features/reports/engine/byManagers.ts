import { analyticsDb, systemDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { resolveSourceIds, sourceIdsWhere, resolveBranchManagerIds, managerIdsWhere, type SourceDimension } from '@/lib/marketing/sources';
import { fetchStageSnapshot, STAGE_SNAPSHOT_METRIC_IDS, DEALS_IN_WORK_METRIC_IDS } from './stageSnapshot';
import { buildProductGroupFilter, productGroupCacheKey } from './productGroupFilter';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, ReportRow, AccountType, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';
import { createdTimeWhere, firstTouchWhere } from '@/lib/metrics/offHoursFilters';
import { buildDealFilterWhere, type DealFilter } from '@/lib/metrics/dealFilters';
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

// Снимок «Стадии (сейчас)» (stageSnapshot.ts) НЕ зависит от периода — свой кэш,
// БЕЗ from/toExcl в ключе (иначе current+comparison запросы с разными периодами
// зря дублировали бы один и тот же снимок). TTL короче обычного rowCache — это
// «сейчас», должно обновляться чаще, чем период-зависимые метрики.
const _snapshotCache = new Map<string, { snap: Awaited<ReturnType<typeof fetchStageSnapshot>>; at: number }>();
const SNAPSHOT_TTL = 2 * 60 * 1000; // 2 min

function mkKey(from: string, toExcl: string, metricIds: string[], pgId?: string, srcKey?: string, offhKey?: string): string {
  return `${from}|${toExcl}|${pgId ?? 'all'}|${srcKey ?? 'all'}|${offhKey ?? 'all'}|${[...metricIds].sort().join(',')}`;
}

function mkSnapshotKey(pgId?: string, srcKey?: string, offhKey?: string): string {
  return `${pgId ?? 'all'}|${srcKey ?? 'all'}|${offhKey ?? 'all'}`;
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
  productGroupIds?: string[]; // раздел «Графики» (мультиселект, задача 29.07): пустой/undefined = все группы
  // Маркетинговый дрилл-даун: ограничить сделками одного значения измерения источников
  sourceFilter?: { dimension: SourceDimension; value: string };
  // Задача 1569: экспериментальные фильтры по нерабочему времени (см.
  // lib/metrics/offHoursFilters.ts) — НЕ funnel-based, поэтому баковаются прямо в
  // SQL WHERE (как pgWhere/srcWhere), а не в память вместе с dealScope/clientType.
  createdTimeFilter?: CreatedTimeFilter;
  firstTouchFilter?: FirstTouchFilter;
  /** «Фильтр сделок» (задача 07.08): режет сам набор сделок отчёта. */
  dealFilters?: DealFilter[];
}

export async function fetchByManagers(opts: ByManagersOptions): Promise<ReportRow[]> {
  const dealScope  = opts.dealScope  ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const deptIds    = opts.departmentIds ?? [];
  const accountType = opts.accountType ?? 'all';
  const pgMode     = opts.productGroupMode ?? 'kc';
  const pgId       = opts.productGroupId;
  const createdTimeFilter = opts.createdTimeFilter ?? 'all';
  const firstTouchFilter  = opts.firstTouchFilter  ?? 'all';

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

  // Фильтр товарных групп — параметризованный (productGroupFilter.ts). Раньше строился
  // конкатенацией строки в SQL (`d.product_group_id = ${pgId}` / ручное экранирование
  // кавычки для head_group_name) — переведено на bound-параметры $N (задача 29.07,
  // требование безопасности брифа: никакой конкатенации пользовательского ввода в SQL).
  // Один и тот же логический фильтр нужен ДВУМ разным SQL-запросам с разным числом уже
  // занятых позиционных параметров — main collected-запрос ($1/$2 период) и снимок
  // «Стадии (сейчас)» (только $1 CURATED_STAGE_IDS) — поэтому строим ДВА варианта.
  const pgFilterInput = { productGroupMode: pgMode, productGroupId: pgId, productGroupIds: opts.productGroupIds };
  const pgFilterMain = buildProductGroupFilter(pgFilterInput, 2); // после [fromIso, toExclIso]
  const pgFilterSnap = buildProductGroupFilter(pgFilterInput, 1); // после [CURATED_STAGE_IDS]
  const pgKey = productGroupCacheKey(pgFilterInput);

  const sysDb = systemDb();

  // Org hierarchy + dept filter run every request (fast, small tables).
  // ОРГСТРУКТУРА — из sa (analyticsDb), НЕ из YC system: синк Битрикса (ночной +
  // кнопка «Синхронизировать» на странице Оргструктуры) с 13.07 пишет ТОЛЬКО в
  // sa.org_resolved_hierarchy/sa.departments; копия в YC system больше никем не
  // обновляется и разъезжается с реальностью (задача 2065: «Спецназ Монолит» в
  // отчёте показывал 6 человек по устаревшей YC-копии против 3 актуальных).
  // Тот же переезд, что deals/route.ts и marketing/sources.ts сделали 13.07 —
  // этот движок тогда пропустили. employees остаётся в system (не переезжал).
  const [orgRes, deptRes, loginRes] = await Promise.all([
    analyticsDb().query<{
      bitrix_user_id: string; manager_name: string;
      department_id: string | null; department_name: string | null;
      rop_bitrix_user_id: string | null; short_login: string | null;
      branch: string | null;
    }>(`SELECT manager_bitrix_user_id AS bitrix_user_id,
              manager_name, department_id, department_name, rop_bitrix_user_id,
              short_login, branch
         FROM sa.org_resolved_hierarchy WHERE is_active = true`),
    deptIds.length
      ? analyticsDb().query<{ bitrix_user_id: string }>(
          `SELECT DISTINCT manager_bitrix_user_id::text AS bitrix_user_id
             FROM sa.org_resolved_hierarchy orh
            WHERE orh.department_id IN (
              SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($1)
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

  // Задача 1569: фильтры по нерабочему времени НЕ funnel-based (в отличие от
  // dealScope/clientType ниже) — режут конкретные сделки, значит идут прямо в SQL
  // WHERE (как pgWhere/srcWhere) и обязаны быть частью ключа кэша строк.
  const df = buildDealFilterWhere(opts.dealFilters);
  const offhWhere = [createdTimeWhere('d', createdTimeFilter), firstTouchWhere('d', firstTouchFilter), df.sql]
    .filter(Boolean).join(' AND ');
  const offhKey = `${createdTimeFilter}:${firstTouchFilter}|df:${df.key}`;

  // Общий WHERE для сделок этого разреза (менеджер IS NOT NULL + пг/источник/
  // нерабочее время) — переиспользуется И обычным collected-запросом, И снимком
  // «Стадии (сейчас)» (stageSnapshot.ts), чтобы фильтры отчёта резали оба одинаково.
  // ДВА варианта notNullWhere (main/snap) — у пг-фильтра разные номера плейсхолдеров
  // в каждом из двух SQL (см. комментарий у pgFilterMain/pgFilterSnap выше).
  const notNullPartsMain = ['d.current_manager_id IS NOT NULL'];
  if (pgFilterMain) notNullPartsMain.push(pgFilterMain.sql);
  if (srcWhere) notNullPartsMain.push(srcWhere);
  if (offhWhere) notNullPartsMain.push(offhWhere);
  const dimConfigMain = {
    idExpr:          'd.current_manager_id::text',
    groupBy:         'GROUP BY d.current_manager_id, d.funnel_id',
    notNullWhere:    notNullPartsMain.join(' AND '),
    funnelBreakdown: true as const,
  };

  const notNullPartsSnap = ['d.current_manager_id IS NOT NULL'];
  if (pgFilterSnap) notNullPartsSnap.push(pgFilterSnap.sql);
  if (srcWhere) notNullPartsSnap.push(srcWhere);
  if (offhWhere) notNullPartsSnap.push(offhWhere);
  const dimConfigSnap = { ...dimConfigMain, notNullWhere: notNullPartsSnap.join(' AND ') };

  // Analytics row cache (pills are NOT part of the key; pgKey/srcKey/offhKey ARE — they change the scope)
  // L1: in-memory Map, per-instance, 10 min. L2: Redis, shared across instances/restarts.
  const key   = mkKey(fromIso, toExclIso, metricIds, pgKey, srcKey, offhKey);
  let   entry = _rowCache.get(key);

  if (!entry || Date.now() - entry.at > ROW_TTL) {
    const rows = await cached(`rpt:mgr:${key}`, reportTtl(toExclIso), async () => {
      const sql = buildCollectedSQL(collected, dimConfigMain);
      if (!sql) return [];
      const res = await analyticsDb().query<FlatRow>(sql, [fromIso, toExclIso, ...(pgFilterMain?.params ?? [])]);
      return res.rows;
    });
    entry = { rows, at: Date.now() };
    _rowCache.set(key, entry);
  }

  // Снимок «Стадии (сейчас)» (задача 2059) — БЕЗ периода вообще, свой кэш (2 мин,
  // короче обычного rowCache — «сейчас» должно обновляться чаще). current+
  // comparison зовут fetchByManagers с РАЗНЫМ period, но снимок один и тот же —
  // кэш по (pgKey/srcKey/offhKey) экономит второй одинаковый запрос.
  const snapKey   = mkSnapshotKey(pgKey, srcKey, offhKey);
  let   snapEntry = _snapshotCache.get(snapKey);
  if (!snapEntry || Date.now() - snapEntry.at > SNAPSHOT_TTL) {
    const snap = await fetchStageSnapshot(dimConfigSnap, pgFilterSnap?.params ?? []);
    snapEntry = { snap, at: Date.now() };
    _snapshotCache.set(snapKey, snapEntry);
  }
  const { pillRows, workByDim } = snapEntry.snap;

  // Apply pills in memory — снимочные per-stage метрики идут ЧЕРЕЗ ТУ ЖЕ pill-
  // агрегацию, что и обычные collected (funnel_id — реальное измерение сделки,
  // funnel-пилюля Первичные/Повторные/Все режет их как обычно, БЕЗ scope_independent
  // обхода).
  const funnels     = await loadFunnels();
  const allMetricIds = [...metricIds, ...STAGE_SNAPSHOT_METRIC_IDS];
  const agg = aggregate(
    [...entry.rows, ...pillRows] as FlatRow[],
    funnels, allMetricIds, dealScope, clientType, scopeIndependentIds,
  );

  // Map to ReportRow[]
  return [...agg.entries()]
    .filter(([id]) => !allowedBitrix || allowedBitrix.has(id))
    .filter(([id]) => {
      if (!accountPrefix || !loginByBitrix) return true;
      return (loginByBitrix.get(id) ?? '').startsWith(accountPrefix);
    })
    .map(([id, metrics]) => {
      const org = orgMap.get(id);
      // «Сделок в работе» (перв./повт./все) — троица напрямую из снимка, НЕ через
      // funnel-пилюлю (тот же паттерн, что calls_count/_repeat/_all).
      const work = workByDim.get(id);
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
