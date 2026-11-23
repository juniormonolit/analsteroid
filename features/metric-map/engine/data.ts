// «Карта показателей» — сырые агрегаты по менеджерам за период.
//
// Числа берутся по ТЕМ ЖЕ определениям метрик каталога, что и отчёт «По менеджерам»
// (dealsMetricCond из lib/metrics/sqlGen.ts: дата этапа метрики + её фильтры из таблицы
// metrics), с тем же населением (d.current_manager_id IS NOT NULL) и теми же границами
// периода (полночь МСК). Разошлись с отчётом — баг карты.
//
// Один запрос даёт строки по менеджерам; срезы «компания» и «отдел» — суммы этих строк
// (каждая сделка у одного current_manager_id, поэтому сумма COUNT DISTINCT по менеджерам
// равна общему COUNT DISTINCT — так же суммирует и «Итого» отчёта).
import { analyticsDb, ycAnalyticsDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { dealsMetricCond, genDealsExpr, dateFieldScope } from '@/lib/metrics/sqlGen';
import { goodsPositionWhere } from '@/lib/metrics/serviceGroups';
import type { Metric } from '@/lib/metrics/types';
import type { Branch } from './tree';

// Слоты карты → кандидаты id в каталоге (первый найденный). «Кол-во сделок (повт.)» в каталоге —
// repeat_created_count (миграция 041); repeat_deals_count — старый id из 006/009, на проде 23.11 его нет.
type Slot = 'deals' | 'reservations' | 'sales' | 'salesSum' | 'shipSum';
const SLOTS: Slot[] = ['deals', 'reservations', 'sales', 'salesSum', 'shipSum'];
const CANDIDATES: Record<Branch, Record<Slot, string[]>> = {
  p: {
    deals: ['primary_deals_count', 'primary_created_count'], reservations: ['primary_reservations_count'],
    sales: ['primary_sales_count'], salesSum: ['primary_sales_amount'], shipSum: ['primary_shipments_amount'],
  },
  r: {
    deals: ['repeat_created_count', 'repeat_deals_count'], reservations: ['repeat_reservations_count'],
    sales: ['repeat_sales_count'], salesSum: ['repeat_sales_amount'], shipSum: ['repeat_shipments_amount'],
  },
};
/** «Все воронки» — последняя опора синтеза, если нет ни метрики ветки, ни парной. */
const ALL_FUNNELS: Record<Slot, string> = {
  deals: 'deals_count', reservations: 'reservations_count', sales: 'sales_count',
  salesSum: 'all_sales_amount', shipSum: 'shipments_amount',
};
const TOTAL_ID = 'shipments_amount';

export interface BranchAgg {
  deals: number;
  reservations: number;
  sales: number;
  salesSum: number;
  shipSum: number;
  /** Σ по продажам числа разных товарных групп в сделке (без групп — считается 1). */
  groups: number;
  /** Продаж без структурированных товарных позиций («товары только текстом» и т.п.). */
  textOnly: number;
}

export interface Agg {
  p: BranchAgg;
  r: BranchAgg;
  /** «Сумма отгрузок» отчёта (shipments_amount, без фильтра воронок). */
  total: number;
}

export function emptyBranch(): BranchAgg {
  return { deals: 0, reservations: 0, sales: 0, salesSum: 0, shipSum: 0, groups: 0, textOnly: 0 };
}
export function emptyAgg(): Agg {
  return { p: emptyBranch(), r: emptyBranch(), total: 0 };
}

export function addAgg(into: Agg, a: Agg): Agg {
  for (const b of ['p', 'r'] as Branch[]) {
    for (const k of Object.keys(into[b]) as (keyof BranchAgg)[]) into[b][k] += a[b][k];
  }
  into.total += a.total;
  return into;
}

/** Период [fromYmd 00:00 МСК, toYmd+1 00:00 МСК) — как отчёт из МСК-браузера. */
export function mskBounds(fromYmd: string, toYmd: string): [string, string] {
  const from = new Date(`${fromYmd}T00:00:00+03:00`);
  const toExcl = new Date(`${toYmd}T00:00:00+03:00`);
  toExcl.setUTCDate(toExcl.getUTCDate() + 1);
  return [from.toISOString(), toExcl.toISOString()];
}

const usable = (m: Metric | undefined): m is Metric =>
  !!m && m.source === 'deals' && !!m.aggFn && !!m.aggField && !!m.dateField;

/** Та же метрика, но в другой воронке: funnel_type заменён (или добавлен) на нужный. */
function withFunnel(base: Metric, b: Branch, id: string): Metric {
  const value = b === 'p' ? 'primary' : 'repeat';
  return {
    ...base, id,
    filters: [...base.filters.filter(f => f.field !== 'funnel_type'), { field: 'funnel_type', op: 'eq', value }],
  };
}

/** Строки каталога напрямую — включая неактивные/скрытые, которых loadMetrics не отдаёт. */
async function rawCatalog(ids: string[], template: Metric): Promise<Map<string, Metric>> {
  const out = new Map<string, Metric>();
  if (!ids.length) return out;
  try {
    const res = await ycAnalyticsDb().query<{
      id: string; name_ru: string; source: string | null; agg_fn: string | null; agg_field: string | null;
      date_field: string | null; filters: string | null;
    }>(
      `SELECT id, name_ru, COALESCE(source, 'deals') AS source, agg_fn, agg_field, date_field, filters::text AS filters
         FROM metrics WHERE id = ANY($1) AND metric_type = 'collected'`,
      [ids],
    );
    for (const r of res.rows) {
      out.set(r.id, {
        ...template, id: r.id, nameRu: r.name_ru, metricType: 'collected',
        source: r.source as Metric['source'], aggFn: r.agg_fn as Metric['aggFn'],
        aggField: r.agg_field, dateField: r.date_field, filters: r.filters ? JSON.parse(r.filters) : [],
      });
    }
  } catch (err) {
    console.warn('[metric-map] прямое чтение каталога не удалось:', err instanceof Error ? err.message : err);
  }
  return out;
}

interface CatalogPick { byBranch: Record<Branch, Record<Slot, Metric>>; total: Metric; notes: string[] }
let _pick: { at: number; v: CatalogPick } | null = null;

/**
 * Определения метрик карты из каталога. Порядок: loadMetrics (активные/видимые) → та же строка
 * напрямую из metrics (неактивная тоже годится) → синтез: парная метрика другой ветки с заменой
 * funnel_type → метрика «все воронки» + funnel_type. Падает, только если нет даже опоры.
 */
async function catalogMetrics(): Promise<CatalogPick> {
  if (_pick && Date.now() - _pick.at < TTL) return _pick.v;
  const loaded = new Map((await loadMetrics()).map(m => [m.id, m]));
  const wanted = [
    ...Object.values(CANDIDATES.p).flat(), ...Object.values(CANDIDATES.r).flat(),
    ...Object.values(ALL_FUNNELS), TOTAL_ID,
  ];
  const missing = wanted.filter(id => !usable(loaded.get(id)));
  const template = [...loaded.values()].find(usable);
  if (!template) throw new Error('Карта показателей: каталог метрик пуст');
  const raw = await rawCatalog(missing, template);
  const find = (id: string): Metric | undefined => {
    const m = loaded.get(id);
    if (usable(m)) return m;
    const r = raw.get(id);
    return usable(r) ? r : undefined;
  };

  const notes: string[] = [];
  const byBranch = { p: {}, r: {} } as Record<Branch, Record<Slot, Metric>>;
  for (const b of ['p', 'r'] as Branch[]) {
    const other: Branch = b === 'p' ? 'r' : 'p';
    for (const slot of SLOTS) {
      const own = CANDIDATES[b][slot].map(find).find(usable);
      if (own) { byBranch[b][slot] = own; continue; }
      const id = CANDIDATES[b][slot][0];
      const pair = CANDIDATES[other][slot].map(find).find(usable);
      const all = find(ALL_FUNNELS[slot]);
      const base = pair ?? all;
      if (!base) throw new Error(`Карта показателей: в каталоге нет метрики «${id}» и опоры для неё`);
      byBranch[b][slot] = withFunnel(base, b, id);
      notes.push(`${id} ← ${base.id} с funnel_type=${b === 'p' ? 'primary' : 'repeat'}`);
    }
  }
  const total = find(TOTAL_ID);
  if (!total) throw new Error(`Карта показателей: в каталоге нет метрики «${TOTAL_ID}»`);
  if (notes.length) console.warn(`[metric-map] нет в каталоге, собрано из парных: ${notes.join('; ')}`);
  const v = { byBranch, total, notes };
  _pick = { at: Date.now(), v };
  return v;
}

export interface FetchOpts {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD включительно
  /** Срез по товарной группе (шкала КЦ, sa.deals.product_group_id), как фильтр отчётов. */
  productGroupId?: number;
}

const _cache = new Map<string, { at: number; rows: Map<string, Agg> }>();
const TTL = 10 * 60 * 1000;

export function clearAggCache() { _cache.clear(); _pick = null; }

/** Агрегаты по менеджерам (ключ — bitrix id менеджера, строкой). */
export async function fetchManagerAggs(opts: FetchOpts): Promise<Map<string, Agg>> {
  const key = `${opts.from}|${opts.to}|${opts.productGroupId ?? 'all'}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.rows;

  const C = await catalogMetrics();
  const [fromIso, toExclIso] = mskBounds(opts.from, opts.to);
  const params: unknown[] = [fromIso, toExclIso];
  const where: string[] = ['d.current_manager_id IS NOT NULL'];
  if (opts.productGroupId !== undefined) {
    params.push(opts.productGroupId);
    where.push(`d.product_group_id = $${params.length}::int`);
  }
  const all: Metric[] = [C.total, ...(['p', 'r'] as Branch[]).flatMap(b => SLOTS.map(sl => C.byBranch[b][sl]))];
  const dateFields = [...new Set(all.map(m => m.dateField!))];
  where.push(`(${dateFields.map(f => dateFieldScope(f)).join(' OR ')})`);

  const cols: string[] = [];
  // Колонки — по слотам (b_slot), а не по id каталога: id могут совпасть у синтезированных.
  cols.push(genDealsExpr({ ...C.total, id: 'm_total' }));
  for (const b of ['p', 'r'] as Branch[]) {
    for (const sl of SLOTS) cols.push(genDealsExpr({ ...C.byBranch[b][sl], id: `m_${b}_${sl.toLowerCase()}` }));
  }
  for (const b of ['p', 'r'] as Branch[]) {
    const saleCond = dealsMetricCond(C.byBranch[b].sales);
    cols.push(`COALESCE(SUM(CASE WHEN ${saleCond} THEN GREATEST(g.n_goods, 1) END), 0) AS ${b}_groups`);
    cols.push(`COUNT(DISTINCT CASE WHEN ${saleCond} AND g.n_goods = 0 THEN d.deal_id END) AS ${b}_text_only`);
  }

  // Комплексность: разные head-группы ТОВАРНЫХ позиций сделки (сервисные — доставка,
  // аренда техники, служебные — не считаются, см. lib/metrics/serviceGroups.ts).
  // Считается только у проданных сделок — остальным не нужна.
  const sql = `
SELECT d.current_manager_id::text AS manager_id,
  ${cols.join(',\n  ')}
FROM deals d
LEFT JOIN LATERAL (
  SELECT count(DISTINCT (_p->>'head_group_id'))::int AS n_goods
    FROM jsonb_array_elements(
      CASE WHEN d.sold_at IS NOT NULL AND jsonb_typeof(d.products) = 'array' THEN d.products ELSE '[]'::jsonb END
    ) _p
   WHERE ${goodsPositionWhere('_p')}
) g ON true
WHERE ${where.join('\n  AND ')}
GROUP BY d.current_manager_id`;

  const res = await analyticsDb().query<Record<string, string | number | null>>(sql, params);
  const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  const rows = new Map<string, Agg>();
  for (const r of res.rows) {
    const agg = emptyAgg();
    for (const b of ['p', 'r'] as Branch[]) {
      const col = (sl: Slot) => num(r[`m_${b}_${sl.toLowerCase()}`]);
      agg[b] = {
        deals: col('deals'),
        reservations: col('reservations'),
        sales: col('sales'),
        salesSum: col('salesSum'),
        shipSum: col('shipSum'),
        groups: num(r[`${b}_groups`]),
        textOnly: num(r[`${b}_text_only`]),
      };
    }
    agg.total = num(r.m_total);
    rows.set(String(r.manager_id), agg);
  }
  _cache.set(key, { at: Date.now(), rows });
  return rows;
}
