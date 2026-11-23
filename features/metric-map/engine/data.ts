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
import { analyticsDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { dealsMetricCond, genDealsExpr } from '@/lib/metrics/sqlGen';
import { goodsPositionWhere } from '@/lib/metrics/serviceGroups';
import type { Metric } from '@/lib/metrics/types';
import type { Branch } from './tree';

/** id метрик каталога, на которых стоит карта. */
export const METRIC_IDS = {
  p: {
    deals: 'primary_deals_count', reservations: 'primary_reservations_count',
    sales: 'primary_sales_count', salesSum: 'primary_sales_amount', shipSum: 'primary_shipments_amount',
  },
  r: {
    deals: 'repeat_deals_count', reservations: 'repeat_reservations_count',
    sales: 'repeat_sales_count', salesSum: 'repeat_sales_amount', shipSum: 'repeat_shipments_amount',
  },
  total: 'shipments_amount',
} as const;

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

async function catalogMetrics(): Promise<Record<string, Metric>> {
  const all = await loadMetrics();
  const byId = new Map(all.map(m => [m.id, m]));
  const ids = [
    ...Object.values(METRIC_IDS.p), ...Object.values(METRIC_IDS.r), METRIC_IDS.total,
  ];
  const out: Record<string, Metric> = {};
  for (const id of ids) {
    const m = byId.get(id);
    if (!m || m.source !== 'deals' || !m.aggFn || !m.aggField || !m.dateField) {
      throw new Error(`Карта показателей: в каталоге нет пригодной метрики «${id}»`);
    }
    out[id] = m;
  }
  return out;
}

export interface FetchOpts {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD включительно
  /** Срез по товарной группе (шкала КЦ, sa.deals.product_group_id), как фильтр отчётов. */
  productGroupId?: number;
}

const _cache = new Map<string, { at: number; rows: Map<string, Agg> }>();
const TTL = 10 * 60 * 1000;

export function clearAggCache() { _cache.clear(); }

/** Агрегаты по менеджерам (ключ — bitrix id менеджера, строкой). */
export async function fetchManagerAggs(opts: FetchOpts): Promise<Map<string, Agg>> {
  const key = `${opts.from}|${opts.to}|${opts.productGroupId ?? 'all'}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.rows;

  const M = await catalogMetrics();
  const [fromIso, toExclIso] = mskBounds(opts.from, opts.to);
  const params: unknown[] = [fromIso, toExclIso];
  const where: string[] = ['d.current_manager_id IS NOT NULL'];
  if (opts.productGroupId !== undefined) {
    params.push(opts.productGroupId);
    where.push(`d.product_group_id = $${params.length}::int`);
  }
  const dateFields = [...new Set(Object.values(M).map(m => m.dateField!))];
  where.push(`(${dateFields.map(f => `(d.${f} >= $1 AND d.${f} < $2)`).join(' OR ')})`);

  const cols: string[] = [];
  const alias = (id: string) => `m_${id}`;
  for (const m of Object.values(M)) cols.push(genDealsExpr({ ...m, id: alias(m.id) }));
  for (const b of ['p', 'r'] as Branch[]) {
    const saleCond = dealsMetricCond(M[METRIC_IDS[b].sales]);
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
      const ids = METRIC_IDS[b];
      agg[b] = {
        deals: num(r[alias(ids.deals)]),
        reservations: num(r[alias(ids.reservations)]),
        sales: num(r[alias(ids.sales)]),
        salesSum: num(r[alias(ids.salesSum)]),
        shipSum: num(r[alias(ids.shipSum)]),
        groups: num(r[`${b}_groups`]),
        textOnly: num(r[`${b}_text_only`]),
      };
    }
    agg.total = num(r[alias(METRIC_IDS.total)]);
    rows.set(String(r.manager_id), agg);
  }
  _cache.set(key, { at: Date.now(), rows });
  return rows;
}
