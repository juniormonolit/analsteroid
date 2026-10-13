import { MATERIAL_CHAIN, type ChainHouse } from './chain';
import type { ModuleDeal, Recommendation, HouseType, StageLadder, LadderStep } from './types';
import type { CrossSellMatrix, CrossSellPriorities } from '@/features/customers/engine/crossSell';

// «Что предложить» клиенту целиком и на конкретный объект (ТЗ владельца 13.10):
// «предлагать конкретному заказчику на конкретный объект соседние (по вероятности
// исторической и по естественной логике цепочек материалов) товарные группы».
//
// Три сигнала, все от групп ПОСЛЕДНИХ отгрузок среза (клиент или объект):
//  • цепочка стройки — майндкарта владельца (chain.ts): после X естественно Y,
//    и есть вопрос из скрипта продаж, с которого заходить; прямой шаг (depth 0)
//    весит больше глубокого;
//  • история — матрица переходов «отгрузили X → следующей покупкой Y» по всей
//    базе (та же, что у «Моих заказчиков», crossSell.ts);
//  • ручные приоритеты «Настройки → Что предложить» (владелец 21.09) — чтобы
//    новая карточка не спорила с уже настроенным.
// Свежесть: группы последней отгрузки весят 1, предыдущей — 0.7, ещё раньше — 0.5.
// Уже отгруженные на срез группы не предлагаем (их видно в «Товарных группах»).

const EXCLUDED = /^(разное|перевозка|доставка|услуг|для логистов|аренда спецтехники|вывоз грунта)/i;
const RECENCY = [1, 0.7, 0.5];
const W_CHAIN = 1;
const W_HISTORY = 1.5;
const W_PRIORITY = 0.8;
const MIN_HISTORY = 30; // меньше переходов из группы — история шумная, не учитываем
const TOP = 3;

export function recommendGroups(
  deals: ModuleDeal[],
  house: HouseType | null,
  matrix: CrossSellMatrix | null,
  priorities: CrossSellPriorities | null,
): Recommendation[] {
  const shipped = deals.filter(d => d.deliveredAt).sort((a, b) => b.deliveredAt!.localeCompare(a.deliveredAt!));
  if (shipped.length === 0) return [];

  const taken = new Set<string>();
  for (const d of shipped) for (const g of d.groups) taken.add(g);

  // Группы последних отгрузок, по свежести (максимум три разных).
  const recent: string[] = [];
  for (const d of shipped) {
    for (const g of d.groups) if (!recent.includes(g) && !EXCLUDED.test(g)) recent.push(g);
    if (recent.length >= RECENCY.length) break;
  }

  const houses: ChainHouse[] = house ? ['any', house] : ['any', 'frame', 'aerated'];
  type Cand = { score: number; ask: string | null; askScore: number; after: string | null; pct: number | null; pctAfter: string | null; sources: Set<Recommendation['sources'][number]> };
  const cand = new Map<string, Cand>();
  const get = (g: string) => {
    let c = cand.get(g);
    if (!c) { c = { score: 0, ask: null, askScore: 0, after: null, pct: null, pctAfter: null, sources: new Set() }; cand.set(g, c); }
    return c;
  };

  recent.slice(0, RECENCY.length).forEach((from, i) => {
    const w = RECENCY[i];
    // Цепочка стройки: лучший (самый прямой) вопрос на пару from → to.
    const best = new Map<string, { depth: number; ask: string }>();
    for (const r of MATERIAL_CHAIN) {
      if (r.from !== from || !houses.includes(r.house)) continue;
      const cur = best.get(r.to);
      if (!cur || r.depth < cur.depth) best.set(r.to, { depth: r.depth, ask: r.ask });
    }
    for (const [to, r] of best) {
      if (taken.has(to) || EXCLUDED.test(to)) continue;
      const c = get(to);
      const s = w * W_CHAIN / (1 + r.depth);
      c.score += s;
      c.sources.add('chain');
      if (s > c.askScore) { c.askScore = s; c.ask = r.ask; c.after = from; }
    }
    // История переходов.
    const row = matrix?.from[from];
    if (row && row.total >= MIN_HISTORY) {
      for (const [to, cnt] of Object.entries(row.to)) {
        if (taken.has(to) || EXCLUDED.test(to) || to === from) continue;
        const p = cnt / row.total;
        if (p < 0.03) continue;
        const c = get(to);
        c.score += w * W_HISTORY * p;
        c.sources.add('history');
        const pct = Math.round(p * 100);
        if (c.pct === null || pct > c.pct) { c.pct = pct; c.pctAfter = from; }
      }
    }
    // Ручные приоритеты «Что предложить».
    (priorities?.[from] ?? []).forEach((to, idx) => {
      if (!to || taken.has(to) || EXCLUDED.test(to)) return;
      const c = get(to);
      c.score += w * W_PRIORITY * (1 - idx * 0.25);
      c.sources.add('priority');
      if (!c.after) c.after = from;
    });
  });

  return [...cand.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, TOP)
    .map(([group, c]) => ({ group, ask: c.ask, after: c.after, pct: c.pct, pctAfter: c.pctAfter, sources: [...c.sources] }));
}

/** Лестница стадий объекта: текущая группа (последняя отгрузка на объект),
 *  выше — рекомендации, ниже — предыдущие этапы. «Ниже» = группы, которые по
 *  цепочке стройки идут ДО текущей (from → текущая), плюс всё, что мы уже
 *  отгружали на этот объект. Если у этапа нет нашей отгрузки — скорее всего
 *  клиент купил его в другом месте (повод спросить и забрать следующий этап). */
export function stageLadder(
  deals: ModuleDeal[],
  house: HouseType | null,
  matrix: CrossSellMatrix | null,
  priorities: CrossSellPriorities | null,
): StageLadder {
  const shipped = deals.filter(d => d.deliveredAt).sort((a, b) => b.deliveredAt!.localeCompare(a.deliveredAt!));
  const last = shipped.find(d => d.topGroup && !EXCLUDED.test(d.topGroup));
  if (!last) return { current: null, next: [], before: [] };
  const current = last.topGroup!;

  // Наша последняя отгрузка каждой группы на объект.
  const ours = new Map<string, { dealId: number; date: string | null; amount: number }>();
  for (const d of shipped) for (const g of d.groups) if (!ours.has(g)) ours.set(g, { dealId: d.dealId, date: d.deliveredAt, amount: d.amount });

  const houses: ChainHouse[] = house ? ['any', house] : ['any', 'frame', 'aerated'];
  // Предыдущие этапы — только прямые шаги карты: на листе дома (каркас/газобетон)
  // глубина ≤ 1, на общих листах (нерудка, бетон) — только depth 0, иначе для
  // каркасного дома внизу всплывают «Бетон»/«Керамзит» из дальних веток.
  const prevDepth = new Map<string, number>();
  for (const r of MATERIAL_CHAIN) {
    if (r.to !== current || !houses.includes(r.house) || r.from === current) continue;
    if (r.depth > (r.house === 'any' ? 0 : 1)) continue;
    const d = prevDepth.get(r.from);
    if (d === undefined || r.depth < d) prevDepth.set(r.from, r.depth);
  }
  // Что предлагаем выше — не может одновременно быть «уже купил» ниже (в карте
  // бывают встречные переходы: утеплитель → кровля и кровля → утеплитель).
  const next = recommendGroups(deals, house, matrix, priorities);
  const before: LadderStep[] = [];
  const seen = new Set<string>([current, ...next.map(r => r.group)]);
  // Сначала наши прошлые отгрузки (по свежести), затем этапы цепочки, которых у нас не было.
  for (const [g, deal] of ours) {
    if (seen.has(g) || EXCLUDED.test(g)) continue;
    seen.add(g);
    before.push({ group: g, deal, byChain: prevDepth.has(g) });
  }
  [...prevDepth.entries()].sort((a, b) => a[1] - b[1]).forEach(([g]) => {
    if (seen.has(g) || EXCLUDED.test(g)) return;
    seen.add(g);
    before.push({ group: g, deal: null, byChain: true });
  });

  return {
    current: { group: current, dealId: last.dealId, date: last.deliveredAt },
    next,
    before: before.slice(0, 6),
  };
}
