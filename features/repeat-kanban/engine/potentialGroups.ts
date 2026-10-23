// «Что можно предложить» — фильтр по ПОТЕНЦИАЛЬНОЙ товарной группе на всю доску (владелец 23.10: «нужен фильтр
// по потенциальной товарной группе… не ограничиваться списком из 3х позиций, топ 5, при чём вес больше у прямых
// запросов от заказчика (после ИИ анализа), потом приоритеты из кросс-селл раздела, потом майндкарта, потом
// статистика»).
//
// Ярусы строго по порядку (не смесь весов, как в карточке клиента — recommend.ts): сначала заполняет первый,
// оставшиеся места — следующий:
//   1. запросы заказчика из разбора звонков — появятся со структурированным разбором (BACKLOG «Повторка: связки,
//      анкеты и ИИ»); сейчас яруса нет;
//   2. ручные приоритеты /cross-sell — по группам последней покупки, по местам (слот = место);
//   3. майндкарта стройки (chain.ts) — прямые шаги первыми (depth);
//   4. статистика переходов «отгрузили X → следующей покупкой Y» (≥ 30 переходов из X, ≥ 10%).
// Минус: всё, что заказчик когда-либо брал (shippedGroups, вся история), «не предлагать» по клиенту
// (sa.client_module_dismissed, уровень клиента) и служебные группы. Считается в памяти — миллисекунды на доску.
// Упрощение против карточки клиента: от групп последней покупки, без весов свежести и без типа дома.
import { analyticsDb } from '@/lib/db/clients';
import { MATERIAL_CHAIN, type ChainHouse } from '@/features/client-module/engine/chain';
import type { CrossSellMatrix, CrossSellPriorities } from '@/features/customers/engine/crossSell';

export type PotentialSource = 'request' | 'priority' | 'chain' | 'history';
export interface PotentialGroup { group: string; source: PotentialSource; after: string | null }

export const POTENTIAL_TOP = 5;
const EXCLUDED = /^(разное|перевозка|доставка|услуг|для логистов|аренда спецтехники|вывоз грунта)/i;
const MIN_HISTORY = 30;
const MIN_PCT = 0.10;

/** «Не предлагать» по клиенту целиком: client_ref (c<контакт>/k<компания>) → группы. Таблица крошечная (единицы
 *  строк на 23.10) — читаем целиком, кэш 2 мин, вместо фильтра по 25 тыс. ключей доски. */
let dismissedCache: { at: number; map: Map<string, Set<string>> } | null = null;
export async function fetchDismissedByRef(): Promise<Map<string, Set<string>>> {
  if (dismissedCache && Date.now() - dismissedCache.at < 120_000) return dismissedCache.map;
  const out = new Map<string, Set<string>>();
  const r = await analyticsDb().query<{ client_ref: string; group_name: string }>(
    `SELECT client_ref, group_name FROM sa.client_module_dismissed WHERE active AND object_key = ''`,
  ).catch(() => ({ rows: [] as { client_ref: string; group_name: string }[] }));
  for (const x of r.rows) { const s = out.get(x.client_ref) ?? new Set<string>(); s.add(x.group_name); out.set(x.client_ref, s); }
  dismissedCache = { at: Date.now(), map: out };
  return out;
}

export function potentialGroups(input: {
  /** Группы последней покупки (снимок «Моих заказчиков»: lastGroups), фолбэк — группа последней отгрузки. */
  recent: string[];
  /** Всё, что когда-либо отгружали, и «не предлагать». */
  taken: ReadonlySet<string>;
  dismissed: ReadonlySet<string>;
  /** Тип клиента из карточки: подрядчику — только общие листы карты (нерудка, бетон), без «дома». */
  contractor: boolean;
  priorities: CrossSellPriorities | null;
  matrix: CrossSellMatrix | null;
  /** Ярус 1 — прямые запросы заказчика (из разбора звонков), когда появятся. */
  requests?: string[];
}): PotentialGroup[] {
  const out: PotentialGroup[] = [];
  const ok = (g: string | null | undefined): g is string =>
    !!g && !input.taken.has(g) && !input.dismissed.has(g) && !EXCLUDED.test(g) && !out.some(x => x.group === g);
  const push = (g: string, source: PotentialSource, after: string | null) => { if (out.length < POTENTIAL_TOP && ok(g)) out.push({ group: g, source, after }); };
  const recent = input.recent.filter(g => !EXCLUDED.test(g)).slice(0, 3);

  for (const g of input.requests ?? []) push(g, 'request', null);
  // Приоритеты: по местам (1-е места всех свежих групп, потом 2-е…) — слот = место, как на странице /cross-sell.
  for (let slot = 0; slot < 3; slot++) for (const from of recent) push(input.priorities?.[from]?.[slot] ?? '', 'priority', from);
  const houses: ChainHouse[] = input.contractor ? ['any'] : ['any', 'frame', 'aerated'];
  const chain = MATERIAL_CHAIN.filter(r => recent.includes(r.from) && houses.includes(r.house))
    .sort((a, b) => a.depth - b.depth || recent.indexOf(a.from) - recent.indexOf(b.from));
  for (const r of chain) push(r.to, 'chain', r.from);
  const hist: { to: string; p: number; from: string }[] = [];
  for (const from of recent) {
    const row = input.matrix?.from[from];
    if (!row || row.total < MIN_HISTORY) continue;
    for (const [to, n] of Object.entries(row.to)) if (to !== from && n / row.total >= MIN_PCT) hist.push({ to, p: n / row.total, from });
  }
  for (const h of hist.sort((a, b) => b.p - a.p)) push(h.to, 'history', h.from);
  return out;
}
