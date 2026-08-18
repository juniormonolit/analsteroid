import { analyticsDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { buildProductGroupFilter, productGroupCacheKey } from './productGroupFilter';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, ReportRow, ProductGroupMode, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';
import { createdTimeWhere, firstTouchWhere } from '@/lib/metrics/offHoursFilters';
import { buildDealFilterWhere, type DealFilter } from '@/lib/metrics/dealFilters';
import { addDays, startOfDay } from 'date-fns';

// Измерение «По сумме сделки» (задача владельца 18.08: «график зависимости суммы
// сделки и конверсии в продажу»). Строка отчёта = корзина по d.amount; внутри
// корзины работают ВСЕ метрики каталога и все фильтры (пилюли первичные/повторные,
// Б2Б/Б2С, отделы, товарные группы, фильтр сделок) — тот же путь, что у
// by-product-groups: buildCollectedSQL с DimensionConfig + пост-фильтр по funnel_id.
//
// Смысловая оговорка про конверсии. CR Сделка → Продажа per-корзина читается как
// «какая доля СОЗДАННЫХ в периоде сделок этого чека продалась В ЭТОМ ЖЕ периоде»
// (числитель и знаменатель — обе collected-метрики периода, как и во всех отчётах).
// Это НЕ когорта «создана в периоде → продана когда-нибудь» — так устроены все
// CR-метрики каталога, корзины лишь наследуют общую семантику.
//
// Границы корзин подобраны по фактическому распределению чека продаж за 90 дней
// (замер 06.08: p25 ≈ 32,5 тыс, медиана ≈ 71 тыс, p75 ≈ 154 тыс, p90 ≈ 300 тыс):
// нижние корзины режут плотную часть распределения, верхние — хвост крупняка.
// dimensionId — порядковый номер корзины: фронт сортирует по нему, а не по value.
const BUCKETS: { id: string; label: string; where: string }[] = [
  { id: '1', label: '0 ₽ / не указана',  where: `(d.amount IS NULL OR d.amount <= 0)` },
  { id: '2', label: 'до 50 тыс ₽',       where: `d.amount > 0 AND d.amount < 50000` },
  { id: '3', label: '50–100 тыс ₽',      where: `d.amount >= 50000 AND d.amount < 100000` },
  { id: '4', label: '100–300 тыс ₽',     where: `d.amount >= 100000 AND d.amount < 300000` },
  { id: '5', label: '300 тыс – 1 млн ₽', where: `d.amount >= 300000 AND d.amount < 1000000` },
  { id: '6', label: '1–3 млн ₽',         where: `d.amount >= 1000000 AND d.amount < 3000000` },
  { id: '7', label: '3 млн ₽ и выше',    where: `d.amount >= 3000000` },
];

export const AMOUNT_BUCKET_LABELS = new Map(BUCKETS.map(b => [b.id, b.label]));

const bucketIdExpr = `CASE\n  ${BUCKETS.map(b => `WHEN ${b.where} THEN '${b.id}'`).join('\n  ')}\nEND`;

// ── Funnel metadata (тот же приём, что byProductGroups.ts) ────────────────────
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

type FlatRow = Record<string, unknown> & { dimension_id: string | null; funnel_id: number };

const _rowCache = new Map<string, { rows: FlatRow[]; at: number }>();
const ROW_TTL = 10 * 60 * 1000;

function computeAllowedFunnels(
  funnels: FunnelMeta[], dealScope: DealScope, clientType: ClientType,
): Set<number> | null {
  if (dealScope === 'all' && clientType === 'all') return null;
  return new Set<number>(funnels.filter(f => {
    const scopeOk = dealScope === 'all' || (dealScope === 'primary' ? !f.isRepeat : f.isRepeat);
    const clientOk = clientType === 'all' || (clientType === 'b2c' ? [0, 2].includes(f.id) : [1, 3].includes(f.id));
    return scopeOk && clientOk;
  }).map(f => f.id));
}

export interface ByAmountBucketsOptions {
  period: DateRange;
  dealScope?: DealScope;
  clientType?: ClientType;
  productGroupMode?: ProductGroupMode;
  productGroupIds?: string[];
  departmentIds?: string[];
  managerId?: string;
  createdTimeFilter?: CreatedTimeFilter;
  firstTouchFilter?: FirstTouchFilter;
  dealFilters?: DealFilter[];
}

export async function fetchByAmountBuckets(opts: ByAmountBucketsOptions): Promise<ReportRow[]> {
  const dealScope  = opts.dealScope  ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const mode       = opts.productGroupMode ?? 'kc';
  const deptIds    = opts.departmentIds ?? [];
  const managerId  = opts.managerId && /^\d+$/.test(opts.managerId) ? opts.managerId : undefined;
  const createdTimeFilter = opts.createdTimeFilter ?? 'all';
  const firstTouchFilter  = opts.firstTouchFilter  ?? 'all';

  const fromIso   = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  // Фильтр по отделам → allow-list менеджеров (та же логика и тот же источник
  // sa.org_resolved_hierarchy, что в byProductGroups.ts — НЕ YC-копия, задача 2065).
  let deptManagerWhere: string | undefined;
  const deptKey = deptIds.length ? [...deptIds].sort().join(',') : undefined;
  if (deptIds.length > 0) {
    const res = await analyticsDb().query<{ bitrix_user_id: string }>(
      `SELECT DISTINCT manager_bitrix_user_id::text AS bitrix_user_id
         FROM sa.org_resolved_hierarchy orh
        WHERE orh.department_id IN (
          SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($1)
        )
          AND orh.is_active = true`,
      [deptIds],
    );
    const ids = res.rows.map(r => r.bitrix_user_id).filter(id => /^\d+$/.test(id));
    deptManagerWhere = ids.length > 0 ? `d.current_manager_id IN (${ids.join(',')})` : '1=0';
  }

  const whereParts: string[] = [];
  if (managerId) whereParts.push(`d.current_manager_id = ${managerId}`);
  if (deptManagerWhere) whereParts.push(deptManagerWhere);
  const df = buildDealFilterWhere(opts.dealFilters);
  const offhWhereStr = [createdTimeWhere('d', createdTimeFilter), firstTouchWhere('d', firstTouchFilter), df.sql]
    .filter(Boolean).join(' AND ');
  if (offhWhereStr) whereParts.push(offhWhereStr);
  const offhKey = `${createdTimeFilter}:${firstTouchFilter}|df:${df.key}`;

  const pgFilterInput = { productGroupMode: mode, productGroupIds: opts.productGroupIds };
  const pgFilterMain = buildProductGroupFilter(pgFilterInput, 2); // после [fromIso, toExclIso]
  const pgKey = productGroupCacheKey(pgFilterInput);

  const whereMainParts = pgFilterMain ? [...whereParts, pgFilterMain.sql] : whereParts;
  const notNullWhere = whereMainParts.length > 0 ? whereMainParts.join(' AND ') : undefined;

  const allMetrics = await loadMetrics();
  const collected  = allMetrics.filter(m => m.metricType === 'collected' && !m.isTest);
  const metricIds  = collected.map(m => m.id);
  const scopeIndependentIds = new Set(
    collected.filter(m => m.tags.includes('scope_independent')).map(m => m.id),
  );

  const dim = {
    idExpr:          bucketIdExpr,
    // Имя приклеивает фронт по AMOUNT_BUCKET_LABELS (dimensionId стабилен);
    // в SQL держим только id, чтобы GROUP BY не таскал второй CASE.
    groupBy:         `GROUP BY ${bucketIdExpr}, d.funnel_id`,
    notNullWhere,
    funnelBreakdown: true as const,
  };

  const key = `${fromIso}|${toExclIso}|${pgKey}|${managerId ?? 'all'}|${deptKey ?? 'all'}|${offhKey}|${[...metricIds].sort().join(',')}`;
  let entry = _rowCache.get(key);
  if (!entry || Date.now() - entry.at > ROW_TTL) {
    const rows = await cached(`rpt:ab:${key}`, reportTtl(toExclIso), async () => {
      const sql = buildCollectedSQL(collected, dim);
      if (!sql) return [];
      const res = await analyticsDb().query<FlatRow>(sql, [fromIso, toExclIso, ...(pgFilterMain?.params ?? [])]);
      return res.rows;
    });
    entry = { rows, at: Date.now() };
    _rowCache.set(key, entry);
  }

  // Пилюли — в памяти, как во всех измерениях (scope_independent-метрики не
  // режутся пилюлей первичных/повторных — тот же диагноз Маркуса, что в byManagers).
  const funnels = await loadFunnels();
  const allowed           = computeAllowedFunnels(funnels, dealScope, clientType);
  const allowedScopeIndep = scopeIndependentIds.size > 0 ? computeAllowedFunnels(funnels, 'all', clientType) : null;

  const agg = new Map<string, Record<string, number>>();
  for (const row of entry.rows) {
    const dimId = row.dimension_id;
    if (dimId === null || dimId === undefined) continue;
    const passesNormal     = allowed === null || allowed.has(row.funnel_id);
    const passesScopeIndep = allowedScopeIndep === null || allowedScopeIndep.has(row.funnel_id);
    if (!passesNormal && !passesScopeIndep) continue;
    if (!agg.has(dimId)) agg.set(dimId, Object.fromEntries(metricIds.map(id => [id, 0])));
    const entryM = agg.get(dimId)!;
    for (const id of metricIds) {
      const passes = scopeIndependentIds.has(id) ? passesScopeIndep : passesNormal;
      if (!passes) continue;
      const v = row[id];
      if (v !== null && v !== undefined) entryM[id] += Number(v);
    }
  }

  return [...agg.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, metrics]) => ({
      dimensionId:   id,
      dimensionName: AMOUNT_BUCKET_LABELS.get(id) ?? id,
      teamId:        null,
      teamName:      null,
      metrics: Object.fromEntries(metricIds.map(mid => [mid, metrics[mid] !== undefined ? metrics[mid] : null])),
    }));
}
