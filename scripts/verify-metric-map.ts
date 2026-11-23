// Сверка «Карты показателей» с отчётом «По менеджерам» на живых данных (корень = «Сумма отгрузок»,
// невязка ≈ 0, перв./повт., сделки, CR, чек) для компании и топ-3 менеджеров (или переданных id).
// Запуск (нужен env БД): npm run verify:metric-map -- [from] [to] [managerId…]
import { computeMetricMap, defaultCompare } from '../features/metric-map/engine/service.ts';
import { fetchManagerAggs } from '../features/metric-map/engine/data.ts';
import { fetchByManagers } from '../features/reports/engine/byManagers.ts';

const [from = '2026-10-01', to = '2026-10-31', ...mgrArg] = process.argv.slice(2);
const period = { from: new Date(`${from}T00:00:00+03:00`), to: new Date(`${to}T12:00:00+03:00`) };
const rows = await fetchByManagers({ period, dealScope: 'all', clientType: 'all' });
const sum = (id: string, f?: (r: typeof rows[number]) => boolean) =>
  rows.filter(r => !f || f(r)).reduce((s, r) => s + Number(r.metrics[id] ?? 0), 0);
const fmt = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('ru-RU'));

const aggs = await fetchManagerAggs({ from, to });
const top = mgrArg.length ? mgrArg : [...aggs.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 3).map(([id]) => id);

const scopes = [{ type: 'company' as const, id: null }, ...top.map(id => ({ type: 'manager' as const, id }))];
for (const s of scopes) {
  const t0 = Date.now();
  const m = await computeMetricMap({ scope: s, from, to, compareFrom: defaultCompare(from, to)[0], compareTo: defaultCompare(from, to)[1] });
  const f = s.id ? (r: typeof rows[number]) => r.dimensionId === s.id : undefined;
  const rep = { total: sum('shipments_amount', f), p: sum('primary_shipments_amount', f), r: sum('repeat_shipments_amount', f),
    pDeals: sum('primary_deals_count', f), pSales: sum('primary_sales_count', f), pRes: sum('primary_reservations_count', f), pSalesSum: sum('primary_sales_amount', f) };
  const v = m.values;
  console.log(`\n== ${m.scope.label} (${s.type}${s.id ? ':' + s.id : ''}) ${m.period.label}, ${Date.now() - t0} мс`);
  console.log(`  корень карты ${fmt(v.root.value)} | отчёт «Сумма отгрузок» ${fmt(rep.total)} | разница ${fmt((v.root.value ?? 0) - rep.total)}`);
  console.log(`  перв. ${fmt(v.p.value)} vs ${fmt(rep.p)}; повт. ${fmt(v.r.value)} vs ${fmt(rep.r)}; residual ${m.residual}`);
  console.log(`  перв.: сделок ${v['p.deals'].value} vs ${rep.pDeals}; CR сд→прод ${v['p.cr'].value?.toFixed(4)} vs ${(rep.pSales / rep.pDeals).toFixed(4)}; чек ${fmt(v['p.check'].value)} vs ${fmt(rep.pSalesSum / rep.pSales)}`);
  for (const id of Object.keys(v)) {
    const x = v[id];
    console.log(`  ${id.padEnd(13)} v=${x.value?.toPrecision(5) ?? '—'} prev=${x.prev?.toPrecision(5) ?? '—'} med=${x.teamMedian?.toPrecision(5) ?? '—'} n=${x.sampleSize ?? '—'}${x.lowSample ? ' LOW' : ''} contrib=${fmt(x.contribution)} pot=${fmt(x.potential)}${x.share != null ? ` share=${(x.share * 100).toFixed(1)}%` : ''}`);
  }
  const comp = m.nodes.find(n => n.id === 'p.complexity')?.description;
  console.log('  ', comp);
  console.log('  ', m.nodes.find(n => n.id === 'r.complexity')?.description);
}
process.exit(0);
