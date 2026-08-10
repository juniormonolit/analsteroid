import { analyticsDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { buildProductGroupFilter, productGroupCacheKey } from './productGroupFilter';
import { getCachedClientNames } from '@/lib/bitrix/clientNames';
import { createdTimeWhere, firstTouchWhere } from '@/lib/metrics/offHoursFilters';
import { buildDealFilterWhere, type DealFilter } from '@/lib/metrics/dealFilters';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, ReportRow, ProductGroupMode, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';
import { addDays, startOfDay } from 'date-fns';

// ── Отчёт «По клиентам» — четвёртая стартовая сущность (задача 10.08) ────────
//
// Строка = клиент (contact_id). Каталожные collected-метрики считаются тем же
// buildCollectedSQL, что у менеджеров/групп, — просто с другим измерением, так
// что «Сумма продаж» клиента и «Сумма продаж» менеджера — одна формула.
// Специфические клиентские метрики (дни с последнего заказа, частота, LTV,
// категории, риск ухода) добираются движком clientMetrics (dimension='client').
//
// Имена — из кэша client_names (лениво наполняется из Битрикса разделом «Мои
// заказчики», lib/bitrix/clientNames.ts). Здесь читаем ТОЛЬКО кэш: у отчёта
// могут быть тысячи строк, ленивый добор из Битрикса на каждую — это сотни
// REST-вызовов на открытие. Пока имени нет в кэше — «Контакт #id»; имена
// доезжают по мере пользования разделом заказчиков.
//
// Ограничения строк нет намеренно: дефолтный период — месяц (~2–4 тыс. строк).
// «Всё время» по всем клиентам будет тяжёлым — осознанный компромисс v1.

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

type FlatRow = Record<string, unknown> & { dimension_id: string; funnel_id: number };

const _rowCache = new Map<string, { rows: FlatRow[]; at: number }>();
const ROW_TTL = 10 * 60 * 1000;

function computeAllowedFunnels(
  funnels: FunnelMeta[], dealScope: DealScope, clientType: ClientType,
): Set<number> | null {
  if (dealScope === 'all' && clientType === 'all') return null;
  return new Set<number>(
    funnels.filter(f => {
      const scopeOk = dealScope === 'all' || (dealScope === 'primary' ? !f.isRepeat : f.isRepeat);
      const clientOk = clientType === 'all'
        || (clientType === 'b2c' ? [0, 2].includes(f.id) : [1, 3].includes(f.id));
      return scopeOk && clientOk;
    }).map(f => f.id),
  );
}

export interface ByClientsOptions {
  period: DateRange;
  dealScope?: DealScope;
  clientType?: ClientType;
  departmentIds?: string[];
  productGroupMode?: ProductGroupMode;
  productGroupIds?: string[];
  createdTimeFilter?: CreatedTimeFilter;
  firstTouchFilter?: FirstTouchFilter;
  dealFilters?: DealFilter[];
}

export async function fetchByClients(opts: ByClientsOptions): Promise<ReportRow[]> {
  const dealScope = opts.dealScope ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const deptIds = opts.departmentIds ?? [];
  const createdTimeFilter = opts.createdTimeFilter ?? 'all';
  const firstTouchFilter = opts.firstTouchFilter ?? 'all';

  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  // Фильтр отделов — клиент относится к отчёту, если сделку в периоде вёл
  // менеджер отдела (та же оргструктура из sa, что в остальных движках).
  let deptWhere: string | undefined;
  const deptKey = deptIds.length ? [...deptIds].sort().join(',') : undefined;
  if (deptIds.length > 0) {
    const res = await analyticsDb().query<{ bitrix_user_id: string }>(
      `SELECT DISTINCT manager_bitrix_user_id::text AS bitrix_user_id
         FROM sa.org_resolved_hierarchy orh
        WHERE orh.department_id IN (
          SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($1)
        ) AND orh.is_active = true`,
      [deptIds],
    );
    const ids = res.rows.map(r => r.bitrix_user_id).filter(id => /^\d+$/.test(id));
    deptWhere = ids.length > 0 ? `d.current_manager_id IN (${ids.join(',')})` : '1=0';
  }

  const pgFilterInput = { productGroupMode: opts.productGroupMode ?? 'kc', productGroupIds: opts.productGroupIds };
  const pgFilter = buildProductGroupFilter(pgFilterInput, 2);
  const pgKey = productGroupCacheKey(pgFilterInput);

  const df = buildDealFilterWhere(opts.dealFilters);
  const offhWhere = [createdTimeWhere('d', createdTimeFilter), firstTouchWhere('d', firstTouchFilter), df.sql]
    .filter(Boolean).join(' AND ');
  const offhKey = `${createdTimeFilter}:${firstTouchFilter}|df:${df.key}`;

  const whereParts = ['d.contact_id IS NOT NULL'];
  if (deptWhere) whereParts.push(deptWhere);
  if (pgFilter) whereParts.push(pgFilter.sql);
  if (offhWhere) whereParts.push(offhWhere);

  const allMetrics = await loadMetrics();
  const collected = allMetrics.filter(m => m.metricType === 'collected' && !m.isTest);
  const metricIds = collected.map(m => m.id);
  const scopeIndependentIds = new Set(
    collected.filter(m => m.tags.includes('scope_independent')).map(m => m.id),
  );

  const dim = {
    idExpr: 'd.contact_id::text',
    groupBy: 'GROUP BY d.contact_id, d.funnel_id',
    notNullWhere: whereParts.join(' AND '),
    funnelBreakdown: true as const,
  };

  const key = `${fromIso}|${toExclIso}|${pgKey}|${deptKey ?? 'all'}|${offhKey}|${[...metricIds].sort().join(',')}`;
  let entry = _rowCache.get(key);
  if (!entry || Date.now() - entry.at > ROW_TTL) {
    const rows = await cached(`rpt:cli:${key}`, reportTtl(toExclIso), async () => {
      const sql = buildCollectedSQL(collected, dim);
      if (!sql) return [];
      const res = await analyticsDb().query<FlatRow>(sql, [fromIso, toExclIso, ...(pgFilter?.params ?? [])]);
      return res.rows;
    });
    entry = { rows, at: Date.now() };
    _rowCache.set(key, entry);
  }

  // Пилюли — постфактум по funnel_id, как в остальных движках.
  const funnels = await loadFunnels();
  const allowed = computeAllowedFunnels(funnels, dealScope, clientType);
  const allowedScopeIndep = scopeIndependentIds.size > 0
    ? computeAllowedFunnels(funnels, 'all', clientType)
    : null;

  const agg = new Map<string, Record<string, number>>();
  for (const row of entry.rows) {
    const passesNormal = allowed === null || allowed.has(row.funnel_id);
    const passesScopeIndep = allowedScopeIndep === null || allowedScopeIndep.has(row.funnel_id);
    if (!passesNormal && !passesScopeIndep) continue;
    let e = agg.get(row.dimension_id);
    if (!e) { e = Object.fromEntries(metricIds.map(id => [id, 0])); agg.set(row.dimension_id, e); }
    for (const id of metricIds) {
      const passes = scopeIndependentIds.has(id) ? passesScopeIndep : passesNormal;
      if (!passes) continue;
      const v = row[id];
      if (v !== null && v !== undefined) e[id] += Number(v);
    }
  }

  const names = await getCachedClientNames([...agg.keys()].map(id => `c${id}`));

  return [...agg.entries()].map(([id, metrics]) => ({
    dimensionId: id,
    dimensionName: names.get(`c${id}`) ?? `Контакт #${id}`,
    dimensionSubtitle: `#${id}`,
    teamId: null,
    teamName: null,
    metrics: Object.fromEntries(metricIds.map(mid => [mid, metrics[mid] !== undefined ? metrics[mid] : null])),
  }));
}
