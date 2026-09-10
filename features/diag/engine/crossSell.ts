// Узел cross_sell_expected_share (миграция 209): по матрице переходов (features/reports/
// engine/productMatrix.ts, режим positions) для каждой категории A известна самая частая
// СЛЕДУЮЩАЯ категория B по компании (газобетон → кровля). На менеджера — доля его повторных
// покупок за 12 мес после A, в которых была B. Владелец 10.09: «после газобетона кровлю
// продают в 10% — у каждых стен есть крыша». Переход атрибутируется менеджеру ЗАКРЫВАЮЩЕЙ
// сделки, как в матрице.
import { analyticsDb } from '@/lib/db/clients';
import { goodsPositionWhere } from '@/lib/metrics/serviceGroups';

export interface CrossSellResult { value: number | null; n: number; hits: number; top: { from: string; expected: string; companyPct: number; ownPct: number | null; n: number }[] }

let _company: { at: number; expected: Map<string, { to: string; pct: number }> } | null = null;

const PAIRS_SQL = (managerFilter: string) => `
WITH deal_cats AS (
  SELECT d.contact_id, d.delivered_at, d.deal_id, d.current_manager_id::text AS mgr,
         array_agg(DISTINCT p->>'head_group_name') AS cats
    FROM sa.deals d, jsonb_array_elements(d.products) p
   WHERE d.delivered_at IS NOT NULL AND d.contact_id IS NOT NULL AND d.funnel_id NOT IN (4, 7)
     AND ${goodsPositionWhere('p')} AND (p->>'head_group_name') IS NOT NULL
   GROUP BY d.contact_id, d.delivered_at, d.deal_id, d.current_manager_id
),
seq AS (
  SELECT contact_id, cats, lead(cats) OVER w AS next_cats, lead(delivered_at) OVER w AS next_at, lead(mgr) OVER w AS next_mgr
    FROM deal_cats WINDOW w AS (PARTITION BY contact_id ORDER BY delivered_at, deal_id)
),
pairs AS (SELECT * FROM seq WHERE next_cats IS NOT NULL AND next_at >= now() - interval '12 months' ${managerFilter})
`;

/** Ожидаемая следующая категория по компании: argmax_B≠A P(A→B) за 12 мес (кэш 6 ч). */
export async function loadCompanyExpected(): Promise<Map<string, { to: string; pct: number }>> {
  if (_company && Date.now() - _company.at < 6 * 3600 * 1000) return _company.expected;
  const r = await analyticsDb().query<{ from_grp: string; to_grp: string | null; n: string }>(
    `${PAIRS_SQL('')}
     SELECT f.cat AS from_grp, t.cat AS to_grp, count(*)::text AS n FROM pairs, unnest(cats) f(cat), unnest(next_cats) t(cat) WHERE t.cat <> f.cat GROUP BY 1, 2
     UNION ALL SELECT f.cat, NULL, count(*)::text FROM pairs, unnest(cats) f(cat) GROUP BY 1`);
  const totals = new Map<string, number>(); const best = new Map<string, { to: string; n: number }>();
  for (const x of r.rows) { if (x.to_grp === null) totals.set(x.from_grp, Number(x.n)); else { const b = best.get(x.from_grp); if (!b || Number(x.n) > b.n) best.set(x.from_grp, { to: x.to_grp, n: Number(x.n) }); } }
  const expected = new Map<string, { to: string; pct: number }>();
  for (const [from, b] of best) { const t = totals.get(from) ?? 0; if (t >= 50) expected.set(from, { to: b.to, pct: (b.n / t) * 100 }); }
  _company = { at: Date.now(), expected };
  return expected;
}

/** Значение узла для набора менеджеров (одним запросом). */
export async function computeCrossSell(managerIds: number[]): Promise<Map<number, CrossSellResult>> {
  const out = new Map<number, CrossSellResult>();
  if (!managerIds.length) return out;
  const expected = await loadCompanyExpected();
  const r = await analyticsDb().query<{ mgr: string; from_grp: string; to_cats: string[] }>(
    `${PAIRS_SQL('AND next_mgr = ANY($1::text[])')}
     SELECT next_mgr AS mgr, f.cat AS from_grp, next_cats AS to_cats FROM pairs, unnest(cats) f(cat)`, [managerIds.map(String)]);
  type Acc = { n: number; hits: number; byFrom: Map<string, { n: number; hits: number }> };
  const acc = new Map<number, Acc>();
  for (const x of r.rows) {
    const exp = expected.get(x.from_grp);
    if (!exp) continue;
    const a = acc.get(Number(x.mgr)) ?? acc.set(Number(x.mgr), { n: 0, hits: 0, byFrom: new Map() }).get(Number(x.mgr))!;
    const hit = x.to_cats.includes(exp.to);
    a.n++; if (hit) a.hits++;
    const f = a.byFrom.get(x.from_grp) ?? a.byFrom.set(x.from_grp, { n: 0, hits: 0 }).get(x.from_grp)!;
    f.n++; if (hit) f.hits++;
  }
  for (const id of managerIds) {
    const a = acc.get(id);
    if (!a) { out.set(id, { value: null, n: 0, hits: 0, top: [] }); continue; }
    const top = [...a.byFrom.entries()].filter(([, v]) => v.n >= 5).map(([from, v]) => {
      const e = expected.get(from)!;
      return { from, expected: e.to, companyPct: Math.round(e.pct * 10) / 10, ownPct: Math.round((v.hits / v.n) * 1000) / 10, n: v.n, gap: (v.hits / v.n) * 100 - e.pct };
    }).sort((x, y) => x.gap - y.gap).slice(0, 3).map(({ gap: _g, ...rest }) => rest);
    out.set(id, { value: a.n ? (a.hits / a.n) * 100 : null, n: a.n, hits: a.hits, top });
  }
  return out;
}
