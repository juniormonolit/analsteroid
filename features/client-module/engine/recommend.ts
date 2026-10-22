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
//  • ручные приоритеты «Ещё → Что предложить» (владелец 21.09) — с 22.10 ГЛАВНЫЙ сигнал
//    («карточка и предлагаемые материалы должны основываться прежде всего на этом, а не только
//    на статистике и майндкарте»): они занимают места в топе первыми, цепочка и история —
//    только оставшиеся места (см. конец recommendGroups).
// Свежесть: группы последней отгрузки весят 1, предыдущей — 0.7, ещё раньше — 0.5.
// Уже отгруженные на срез группы не предлагаем (их видно в «Товарных группах»).

const EXCLUDED = /^(разное|перевозка|доставка|услуг|для логистов|аренда спецтехники|вывоз грунта)/i;
const RECENCY = [1, 0.7, 0.5];
const W_CHAIN = 1;
const W_HISTORY = 1.5;
const W_PRIORITY = 0.8;
const MIN_HISTORY = 30; // меньше переходов из группы — история шумная, не учитываем
const TOP = 3;
/** История без поддержки цепочки/приоритета — только от 10% (аудит 14.10: «4% после
 *  сухих смесей» — шум, из-за которого менеджер перестаёт читать блок). */
const MIN_PCT_ALONE = 0.10;
/** «Сейчас» на объекте — не мелочь: ≥ 50 тыс ₽ или ≥ 5% суммы объекта. */
const CURRENT_MIN_AMOUNT = 50_000;
const CURRENT_MIN_SHARE = 0.05;
const CURRENT_WINDOW_DAYS = 45;

/** Профиль клиента для рекомендаций (аудит 14.10): подрядчику, который возит ЖБИ
 *  и щебень, не предлагаем «газобетон и фасад под сайдинг» с листов дома. */
export type ClientProfileKind = 'builder' | 'contractor';
const CONTRACTOR_GROUPS = /(жби|щебень|песок|бетон и раствор|дорожные плиты|аэродромные|асфальт|грунт|фбс|кольца|лотки|опоры|керамзит|вторичные|арматура|плиты перекрытия|прочий металлопрокат|трубы)/i;

export function profileKind(clientType: string | null, deals: ModuleDeal[]): ClientProfileKind {
  if (clientType === 'self_builder' || clientType === 'self_builder_late' || clientType === 'foreman') return 'builder';
  if (clientType === 'construction_org' || clientType === 'own_needs_org') return 'contractor';
  // Тип не указан — по составу отгрузок: больше половины суммы ЖБИ/нерудка/бетон → подрядчик.
  let all = 0, heavy = 0;
  for (const d of deals) if (d.deliveredAt) for (const p of d.products) {
    if (p.isService || !p.group) continue;
    all += p.sum; if (CONTRACTOR_GROUPS.test(p.group)) heavy += p.sum;
  }
  return all > 0 && heavy / all > 0.5 ? 'contractor' : 'builder';
}

export function recommendGroups(
  deals: ModuleDeal[],
  house: HouseType | null,
  matrix: CrossSellMatrix | null,
  priorities: CrossSellPriorities | null,
  kind: ClientProfileKind = 'builder',
  /** «Не предлагать» (sa.client_module_dismissed) — отсекаются ДО топ-3, место занимает следующая. */
  excluded: ReadonlySet<string> = new Set(),
): Recommendation[] {
  const shipped = deals.filter(d => d.deliveredAt).sort((a, b) => b.deliveredAt!.localeCompare(a.deliveredAt!));
  if (shipped.length === 0) return [];

  const taken = new Set<string>();
  for (const d of shipped) for (const g of d.groups) taken.add(g);

  // Группы последних отгрузок, по свежести (максимум три разных). Мелочь (штукатурка
  // на 12 тыс у подрядчика с миллионами) направление не задаёт — берём крупные
  // отгрузки, а если крупных нет — все.
  const total = shipped.reduce((s, d) => s + d.amount, 0);
  const bigOnes = shipped.filter(d => d.amount >= CURRENT_MIN_AMOUNT || d.amount >= total * CURRENT_MIN_SHARE);
  const recent: string[] = [];
  for (const d of (bigOnes.length ? bigOnes : shipped)) {
    for (const g of d.groups) if (!recent.includes(g) && !EXCLUDED.test(g)) recent.push(g);
    if (recent.length >= RECENCY.length) break;
  }

  // Подрядчику — только общие листы карты (нерудка, бетон), без «дома».
  const houses: ChainHouse[] = kind === 'contractor' ? ['any'] : house ? ['any', house] : ['any', 'frame', 'aerated'];
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
        // Слабая история (<10%) — только в подкрепление цепочки/приоритета, сама по себе шум.
        if (p < 0.03 || (p < MIN_PCT_ALONE && !cand.has(to))) continue;
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

  // Ручные приоритеты — прежде всего (владелец 22.10). Как на странице «Что предложить» и в «Моих
  // заказчиках» (crossSell.ts → recommendFor): у самой свежей отгруженной группы, для которой они
  // заданы, слот = место в списке (пустой слот — место майндкарты/статистики). Приоритеты остальных
  // свежих групп идут сразу следом, перед майндкартой и статистикой. Уже купленное, «не предлагать»
  // и служебные группы пропускаются — место достаётся следующему.
  const okManual = (g: string | null | undefined): g is string => !!g && !taken.has(g) && !EXCLUDED.test(g) && !excluded.has(g);
  const fresh = recent.slice(0, RECENCY.length);
  const primaryFrom = fresh.find(f => (priorities?.[f] ?? []).some(okManual)) ?? null;
  const slots = new Map<number, string>();
  // Явно пустой слот (null) держит место за майндкартой/статистикой; уже купленный или «не
  // предлагать» приоритет места не держит — следующие ручные сдвигаются вверх.
  if (primaryFrom) {
    let pos = 0;
    for (const g of priorities![primaryFrom] ?? []) {
      if (g === null) { pos++; continue; }
      if (!okManual(g)) continue;
      if (pos < TOP) slots.set(pos, g);
      pos++;
    }
  }
  const manualAfter = new Map<string, string>();
  if (primaryFrom) for (const g of slots.values()) manualAfter.set(g, primaryFrom);
  const extra: string[] = [];
  for (const f of fresh) {
    if (f === primaryFrom) continue;
    for (const g of priorities?.[f] ?? []) if (okManual(g) && !manualAfter.has(g)) { extra.push(g); manualAfter.set(g, f); }
  }
  const used = new Set(slots.values());
  const queue = [
    ...extra.filter(g => !used.has(g)),
    ...[...cand.entries()].filter(([g]) => !excluded.has(g) && !manualAfter.has(g)).sort((a, b) => b[1].score - a[1].score).map(([g]) => g),
  ];
  const order: string[] = [];
  for (let pos = 0; pos < TOP; pos++) {
    const g = slots.get(pos) ?? queue.shift();
    if (g) order.push(g);
  }
  return order.map(group => {
    const c = get(group);
    const from = manualAfter.get(group);
    // Для ручного приоритета «после» — та группа, к которой он задан; вопрос из майндкарты — только
    // если он про эту же пару (иначе «после X спросите…» ссылался бы не на ту отгрузку).
    const ask = from && c.after !== from ? null : c.ask;
    return { group, ask, after: from ?? c.after, pct: c.pct, pctAfter: c.pctAfter, sources: [...c.sources] };
  });
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
  kind: ClientProfileKind = 'builder',
  excluded: ReadonlySet<string> = new Set(),
): StageLadder {
  const shipped = deals.filter(d => d.deliveredAt).sort((a, b) => b.deliveredAt!.localeCompare(a.deliveredAt!));
  const goods = shipped.filter(d => d.topGroup && !EXCLUDED.test(d.topGroup));
  if (goods.length === 0) return { current: null, next: [], before: [] };
  // «Сейчас» (аудит 14.10): не последняя отгрузка (штукатурка на 12 тыс на объекте
  // в 2,4 млн), а самая крупная за 45 дней до последней — и не мелочь.
  const total = goods.reduce((s, d) => s + d.amount, 0);
  const lastAt = new Date(goods[0].deliveredAt!).getTime();
  const big = (d: ModuleDeal) => d.amount >= CURRENT_MIN_AMOUNT || d.amount >= total * CURRENT_MIN_SHARE;
  const recent = goods.filter(d => lastAt - new Date(d.deliveredAt!).getTime() <= CURRENT_WINDOW_DAYS * 86_400_000 && big(d));
  const last = recent.sort((a, b) => b.amount - a.amount)[0] ?? goods.find(big) ?? goods[0];
  const current = last.topGroup!;

  // Наша последняя отгрузка каждой группы на объект.
  const ours = new Map<string, { dealId: number; date: string | null; amount: number }>();
  for (const d of shipped) for (const g of d.groups) if (!ours.has(g)) ours.set(g, { dealId: d.dealId, date: d.deliveredAt, amount: d.amount });

  const houses: ChainHouse[] = kind === 'contractor' ? ['any'] : house ? ['any', house] : ['any', 'frame', 'aerated'];
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
  const next = recommendGroups(deals, house, matrix, priorities, kind, excluded);
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
