// «Карта показателей» — из агрегатов (data.ts) в MetricMapResponse (контракт — ../types.ts).
// Чистая математика без БД: значения узлов, доли, LMDI-вклады, медиана команды, потенциал.
import type { MapNodeDef, MapNodeValue } from '../types';
import { BRANCHES, ROOT_ID, buildNodes, isAdditive, type Branch } from './tree';
import type { Agg } from './data';

type Vals = Record<string, number | null>;

const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Значения всех узлов по агрегату среза. Отношения — всегда отношения сумм. */
export function nodeValues(a: Agg): { value: Vals; sample: Vals } {
  const value: Vals = { [ROOT_ID]: a.total };
  const sample: Vals = { [ROOT_ID]: null };
  for (const b of BRANCHES) {
    const x = a[b];
    value[b] = x.shipSum;
    value[`${b}.deals`] = x.deals;
    value[`${b}.cr`] = div(x.sales, x.deals);
    value[`${b}.cr_book`] = div(x.reservations, x.deals);
    value[`${b}.cr_sale`] = div(x.sales, x.reservations);
    value[`${b}.check`] = div(x.salesSum, x.sales);
    value[`${b}.complexity`] = div(x.groups, x.sales);
    value[`${b}.per_group`] = div(x.salesSum, x.groups);
    value[`${b}.ship`] = div(x.shipSum, x.salesSum);

    sample[b] = null;
    sample[`${b}.deals`] = x.deals;
    sample[`${b}.cr`] = x.deals;
    sample[`${b}.cr_book`] = x.deals;
    sample[`${b}.cr_sale`] = x.reservations;
    sample[`${b}.check`] = x.sales;
    sample[`${b}.complexity`] = x.sales;
    sample[`${b}.per_group`] = x.sales;
    sample[`${b}.ship`] = x.sales;
  }
  return { value, sample };
}

/** Собрать узел по детям (Σ / Π), null — если чего-то не хватает. */
function assemble(defs: Map<string, MapNodeDef>, value: Vals, id: string): number | null {
  const d = defs.get(id)!;
  if (d.kind === 'leaf' || !d.children?.length) return value[id] ?? null;
  const parts = d.children.map(c => assemble(defs, value, c));
  if (d.kind === 'sum') return parts.reduce<number>((s, v) => s + (v ?? 0), 0);
  return parts.some(v => v === null) ? null : parts.reduce<number>((s, v) => s * v!, 1);
}

/**
 * Значение корня при сценарии «узел id = newValue, прочее как есть» — приращениями от
 * факта, ровно как «что если» интерфейса (ui/tree.ts::scenarioValues), чтобы потенциал
 * движка и сценарий на экране совпадали.
 */
function rootWithOverride(defs: Map<string, MapNodeDef>, parentOf: Map<string, string>, value: Vals, id: string, newValue: number): number | null {
  let cur = id;
  let oldV = value[id];
  let newV: number = newValue;
  if (oldV === null || oldV === undefined) return null;
  while (cur !== ROOT_ID) {
    const p = parentOf.get(cur)!;
    const pv = value[p];
    if (pv === null || pv === undefined) return null;
    const kind = defs.get(p)!.kind;
    let np: number;
    if (kind === 'sum') np = pv + (newV - oldV);
    else {
      if (oldV === 0) return null;
      np = pv * (newV / oldV);
    }
    cur = p; oldV = pv; newV = np;
  }
  return newV;
}

/** Логарифмическое среднее L(a,b) = (a−b)/(ln a − ln b); L(a,a)=a. */
function logMean(a: number, b: number): number | null {
  if (!(a > 0) || !(b > 0)) return null;
  if (Math.abs(a - b) < 1e-9 * Math.max(a, b)) return a;
  return (a - b) / (Math.log(a) - Math.log(b));
}

/**
 * LMDI-вклады в изменение корня. Корень и слагаемые sum-узла — их приращение; цепочка
 * произведений под слагаемым P — L(P₁,P₀)·ln(x₁/x₀) для каждого множителя на любой
 * глубине (вложенный product раскладывает свой вклад на детей тем же коэффициентом).
 */
function contributions(defs: Map<string, MapNodeDef>, cur: Vals, prev: Vals): Vals {
  const out: Vals = {};
  const visit = (id: string, k: number | null | undefined) => {
    const d = defs.get(id)!;
    const c = cur[id], p = prev[id];
    if (k === undefined) {
      // слагаемое (или корень): вклад = приращение
      out[id] = c !== null && c !== undefined && p !== null && p !== undefined ? c - p : null;
    } else {
      out[id] = k !== null && c && p && c > 0 && p > 0 ? k * Math.log(c / p) : null;
    }
    if (!d.children?.length) return;
    if (d.kind === 'sum') {
      for (const ch of d.children) visit(ch, undefined);
    } else {
      // product: коэффициент цепочки — от её верхнего узла
      const kk = k !== undefined ? k : (c != null && p != null ? logMean(c, p) : null);
      for (const ch of d.children) visit(ch, kk);
    }
  };
  visit(ROOT_ID, undefined);
  return out;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Минимум сделок за окно, чтобы менеджер участвовал в медиане аддитивных узлов. */
const MIN_DEALS_ADDITIVE = 10;

export interface ComputeInput {
  cur: Agg;
  prev: Agg;
  /** Агрегаты менеджеров команды за окно медиан. */
  teamWindow: Agg[];
  /** Срез — один менеджер (только тогда считаем медиану аддитивных узлов). */
  singleManager: boolean;
  /** Длина периода / длина окна медиан — масштаб аддитивных медиан. */
  periodToWindow: number;
}

export interface ComputeOutput {
  nodes: MapNodeDef[];
  values: Record<string, MapNodeValue>;
  residual: number | null;
}

function coverageNote(a: Agg, b: Branch): string {
  const x = a[b];
  if (x.sales <= 0) return 'Продаж в периоде нет.';
  const pct = Math.round((x.textOnly / x.sales) * 1000) / 10;
  return `Покрытие: ${x.sales - x.textOnly} из ${x.sales} продаж с товарными позициями; ` +
    `${x.textOnly} (${String(pct).replace('.', ',')} %) без них («товары только текстом» и т.п.) считаются одной группой.`;
}

export function computeMap(inp: ComputeInput): ComputeOutput {
  const nodes = buildNodes({ p: coverageNote(inp.cur, 'p'), r: coverageNote(inp.cur, 'r') });
  const defs = new Map(nodes.map(n => [n.id, n]));
  const parentOf = new Map<string, string>();
  for (const n of nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);

  const cur = nodeValues(inp.cur);
  const prev = nodeValues(inp.prev);
  const contrib = contributions(defs, cur.value, prev.value);
  const team = inp.teamWindow.map(nodeValues);
  const teamAggs = inp.teamWindow;

  const values: Record<string, MapNodeValue> = {};
  for (const n of nodes) {
    const value = cur.value[n.id] ?? null;
    const sampleSize = cur.sample[n.id] ?? null;

    // Медиана команды: только менеджеры с достаточной выборкой за окно.
    let teamMedian: number | null = null;
    if (isAdditive(n.id)) {
      if (inp.singleManager) {
        const xs: number[] = [];
        team.forEach((t, i) => {
          const a = teamAggs[i];
          const deals = n.id === ROOT_ID ? a.p.deals + a.r.deals : a[n.id.slice(0, 1) as Branch].deals;
          const v = t.value[n.id];
          if (deals >= MIN_DEALS_ADDITIVE && v !== null && v !== undefined) xs.push(v);
        });
        const m = median(xs);
        teamMedian = m === null ? null : m * inp.periodToWindow;
      }
    } else {
      const min = n.minSample ?? 0;
      const xs: number[] = [];
      for (const t of team) {
        const v = t.value[n.id];
        const s = t.sample[n.id];
        if (v !== null && v !== undefined && (s ?? 0) >= min) xs.push(v);
      }
      teamMedian = median(xs);
    }

    let potential: number | null = null;
    if (teamMedian !== null && value !== null) {
      if (value >= teamMedian) potential = 0;
      else {
        const r1 = rootWithOverride(defs, parentOf, cur.value, n.id, teamMedian);
        const r0 = cur.value[ROOT_ID];
        potential = r1 !== null && r0 !== null ? r1 - r0 : null;
      }
    }

    const parent = parentOf.get(n.id);
    let share: number | null | undefined;
    if (parent && defs.get(parent)!.kind === 'sum') {
      const pv = cur.value[parent];
      share = pv && value !== null ? value / pv : null;
    }

    values[n.id] = {
      value,
      prev: prev.value[n.id] ?? null,
      teamMedian,
      sampleSize,
      lowSample: n.minSample !== undefined && sampleSize !== null && sampleSize < n.minSample,
      ...(share !== undefined ? { share } : {}),
      contribution: contrib[n.id] ?? null,
      potential,
    };
  }

  const assembled = assemble(defs, cur.value, ROOT_ID);
  const fact = cur.value[ROOT_ID];
  const residual = assembled !== null && fact !== null ? fact - assembled : null;
  return { nodes, values, residual };
}
