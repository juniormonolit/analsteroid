// DEV-фикстура «Карты показателей» на цифрах владельца (23.11): первичка — 190 сделок,
// CR 25%, ср. чек 130 000, коэф. отгрузки 90% → 5 557 500; повторка — 40% суммы →
// всего отгрузок 9 262 500. Используется только в dev, пока /api/metric-map не отвечает
// (или с ?fixture=1). Вклады (LMDI) и потенциал считаются здесь же, чтобы сходились.
import type { MapNodeDef, MapNodeValue, MapScope, MetricMapResponse } from '../types';
import { indexTree, scenarioValues } from './tree';

type Leaf = { cur: number; prev: number; median: number | null; n: number; low?: boolean };

function branch(p: 'p' | 'r', tag: string): MapNodeDef[] {
  return [
    { id: `${p}.deals`, label: `Кол-во сделок (${tag})`, kind: 'leaf', unit: 'count', formula: `Сделки (${tag}), созданные в периоде`, description: 'Сколько сделок завели в воронке за период.' },
    { id: `${p}.cr`, label: `CR Сделка → Продажа (${tag})`, kind: 'product', unit: 'pct', children: [`${p}.cr_book`, `${p}.cr_sale`], formula: `Кол-во продаж (${tag}) / Кол-во сделок (${tag})`, description: 'Какая доля сделок дошла до продажи. Раскладывается на две ступени воронки.', minSample: 30 },
    { id: `${p}.cr_book`, label: `CR Сделка → Бронь (${tag})`, kind: 'leaf', unit: 'pct', formula: `Кол-во броней (${tag}) / Кол-во сделок (${tag})`, minSample: 30 },
    { id: `${p}.cr_sale`, label: `CR Бронь → Продажа (${tag})`, kind: 'leaf', unit: 'pct', formula: `Кол-во продаж (${tag}) / Кол-во броней (${tag})`, minSample: 20 },
    { id: `${p}.check`, label: `Ср. чек (${tag})`, kind: 'product', unit: 'rub', children: [`${p}.complexity`, `${p}.per_group`], formula: `Сумма продаж (${tag}) / Кол-во продаж (${tag})`, description: 'Средняя сумма одной продажи = сколько разных товарных групп в чеке × сколько в среднем на группу.' },
    { id: `${p}.complexity`, label: `Комплексность (${tag})`, kind: 'leaf', unit: 'ratio', formula: `Σ разных товарных групп в продажах / Кол-во продаж (${tag})`, description: 'Сколько разных товарных групп в среднем в одном чеке.' },
    { id: `${p}.per_group`, label: `Ср. сумма на группу (${tag})`, kind: 'leaf', unit: 'rub', formula: `Сумма продаж (${tag}) / Σ товарных групп в продажах`, minSample: 15 },
    { id: `${p}.ship`, label: `Коэф. отгрузки (${tag})`, kind: 'leaf', unit: 'pct', formula: `Сумма отгрузок (${tag}) / Сумма продаж (${tag})`, description: 'Какая часть проданного реально отгружена в периоде.' },
  ];
}

const NODES: MapNodeDef[] = [
  { id: 'root', label: 'Сумма отгрузок', kind: 'sum', unit: 'rub', children: ['p', 'r'], formula: 'Сумма отгрузок (перв.) + Сумма отгрузок (повт.)', description: 'Корень карты. Первичка и повторка — по воронке сделки.' },
  { id: 'p', label: 'Сумма отгрузок (перв.)', kind: 'product', unit: 'rub', children: ['p.deals', 'p.cr', 'p.check', 'p.ship'], formula: 'Кол-во сделок × CR Сделка → Продажа × Ср. чек × Коэф. отгрузки' },
  { id: 'r', label: 'Сумма отгрузок (повт.)', kind: 'product', unit: 'rub', children: ['r.deals', 'r.cr', 'r.check', 'r.ship'], formula: 'Кол-во сделок × CR Сделка → Продажа × Ср. чек × Коэф. отгрузки' },
  ...branch('p', 'перв.'),
  ...branch('r', 'повт.'),
];

const LEAVES: Record<string, Leaf> = {
  'p.deals': { cur: 190, prev: 176, median: 205, n: 190 },
  'p.cr_book': { cur: 0.5, prev: 0.52, median: 0.55, n: 190 },
  'p.cr_sale': { cur: 0.5, prev: 0.47, median: 0.5, n: 95 },
  'p.complexity': { cur: 1.3, prev: 1.25, median: 1.4, n: 47.5 },
  'p.per_group': { cur: 100_000, prev: 98_000, median: 96_000, n: 62 },
  'p.ship': { cur: 0.9, prev: 0.92, median: 0.93, n: 47.5 },
  'r.deals': { cur: 125, prev: 118, median: 120, n: 125 },
  'r.cr_book': { cur: 0.625, prev: 0.6, median: 0.66, n: 125 },
  'r.cr_sale': { cur: 0.64, prev: 0.66, median: 0.62, n: 78 },
  'r.complexity': { cur: 1.2, prev: 1.22, median: 1.35, n: 50 },
  'r.per_group': { cur: 65_000, prev: 61_000, median: 70_000, n: 12, low: true },
  'r.ship': { cur: 0.95, prev: 0.94, median: 0.95, n: 50 },
};

export function buildFixture(scope: MapScope, period: { from: string; to: string; label: string }, compare: { from: string; to: string; label: string }): MetricMapResponse {
  const idx = indexTree({ nodes: NODES });
  const cur: Record<string, number> = {};
  const prev: Record<string, number> = {};
  const med: Record<string, number | null> = {};
  const calc = (id: string, src: Record<string, number>, pick: (l: Leaf) => number): number => {
    const d = idx.byId.get(id)!;
    if (!d.children) return (src[id] = pick(LEAVES[id]));
    const xs = d.children.map(c => calc(c, src, pick));
    return (src[id] = d.kind === 'sum' ? xs.reduce((a, b) => a + b, 0) : xs.reduce((a, b) => a * b, 1));
  };
  calc('root', cur, l => l.cur);
  calc('root', prev, l => l.prev);
  // Медиана составного узла ≈ произведение медиан детей (для фикстуры достаточно).
  const medCalc = (id: string): number | null => {
    const d = idx.byId.get(id)!;
    if (!d.children) return (med[id] = LEAVES[id].median);
    const xs = d.children.map(medCalc);
    if (d.kind === 'sum' || xs.some(x => x == null)) return (med[id] = null);
    return (med[id] = (xs as number[]).reduce((a, b) => a * b, 1));
  };
  medCalc('root');

  // Вклад в Δ корня: sum — Δ ребёнка; product — LMDI, вложенный product делит вклад
  // родителя пропорционально ln-отношениям детей.
  const contrib: Record<string, number> = {};
  const split = (id: string, c: number) => {
    contrib[id] = c;
    const d = idx.byId.get(id)!;
    if (!d.children) return;
    if (d.kind === 'sum') { for (const ch of d.children) split(ch, cur[ch] - prev[ch]); return; }
    const lnTotal = Math.log(cur[id] / prev[id]);
    for (const ch of d.children) {
      const w = lnTotal === 0 ? 0 : Math.log(cur[ch] / prev[ch]) / lnTotal;
      split(ch, c * w); // = L(V1,V0)·ln(x1/x0), когда c = ΔV узла
    }
  };
  split('root', cur.root - prev.root);

  const base = { rootId: 'root', nodes: NODES, values: {} as Record<string, MapNodeValue> };
  for (const n of NODES) base.values[n.id] = { value: cur[n.id], prev: prev[n.id], teamMedian: null, sampleSize: null, lowSample: false };

  const values: Record<string, MapNodeValue> = {};
  for (const n of NODES) {
    const leaf = LEAVES[n.id];
    const parent = idx.parentOf.get(n.id);
    const m = med[n.id] ?? null;
    let potential: number | null = null;
    if (m != null && m > cur[n.id] && parent && idx.byId.get(parent)?.kind === 'product') {
      potential = (scenarioValues(base, idx, { [n.id]: m }).root ?? 0) - cur.root;
    }
    values[n.id] = {
      value: cur[n.id],
      prev: prev[n.id],
      teamMedian: m,
      sampleSize: leaf ? leaf.n : null,
      lowSample: !!leaf?.low,
      share: parent && idx.byId.get(parent)?.kind === 'sum' ? cur[n.id] / cur[parent] : undefined,
      contribution: contrib[n.id] ?? null,
      potential,
    };
  }

  return {
    ...base,
    values,
    scope,
    period,
    comparePeriod: compare,
    residual: 0,
    computedAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
    windowMonths: 6,
  };
}
