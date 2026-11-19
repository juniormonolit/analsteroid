// S4 — чистые функции: текст дубль-задачи (по образцу задач бизнес-процесса, сверено 19.11 на задачах
// 179723/179702 проекта «Теплоизоляция»), комментарии в задачу, план строк товаров сделки для «Принять вариант».
// Без сети и БД — проверяется scripts/assert-logist-bx.ts.
import type { Offer, OfferLine, RequestDetails, RequestItem } from '../requests/contract';
import type { DealRowChange, DealRowView } from './types';

// ── числа и даты ────────────────────────────────────────────────────────────────────────

/** «49 750.00» — как в задачах бизнес-процесса (пробел-разделитель, точка, 2 знака). */
export function money(n: number): string {
  const [int, frac] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${frac}`;
}
/** «995», «12.5» — без лишних нулей. */
export function num(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}
/** YYYY-MM-DD → DD.MM.YYYY */
export function ruDate(d: string | null | undefined): string | null {
  const m = d ? /^(\d{4})-(\d{2})-(\d{2})/.exec(d) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
}
const dash = (s: string | null | undefined) => (s && s.trim() ? s.trim() : '-');
const qty = (q: number | null, m: string | null) => (q == null ? '-' : `${num(q)} ${m?.trim() || 'шт'}`);
/** BB-разметка из пользовательского текста не должна ломать нашу: закрывающие теги гасим. */
export function bbSafe(s: string): string {
  return s.replace(/\[(\/?)(table|tr|td|url|b|i|u|s|color|size|code|quote|list|user)\b/gi, '[ $1$2');
}
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);

// ── дубль-задача ────────────────────────────────────────────────────────────────────────

const SERVICE_RE = /^(доставка|перевозка|разгрузка|погрузка|услуг|манипулятор|кран)/i;
const isService = (i: Pick<RequestItem, 'name' | 'productGroup'>) =>
  SERVICE_RE.test(i.name.trim()) || /^(доставка|перевозка|услуг)/i.test(i.productGroup ?? '');

/** «Утеплитель Минеральная вата и стекловата | 50 упак | Всеволожск, ул…» (как у бизнес-процесса). */
export function taskTitle(r: Pick<RequestDetails, 'id' | 'items' | 'productGroups' | 'address' | 'deal'>): string {
  const goods = r.items.filter(i => !isService(i));
  const first = goods[0] ?? r.items[0] ?? null;
  const head = first?.productGroup || r.productGroups[0] || first?.name || (r.deal ? `Сделка #${r.deal.id}` : `Запрос №${r.id}`);
  const parts = [cut(head.trim(), 120)];
  if (first && first.quantity != null) parts.push(qty(first.quantity, first.measure));
  if (r.address && r.address.trim()) parts.push(cut(r.address.trim(), 50));
  return parts.join(' | ').slice(0, 250);
}

export interface DescriptionCtx {
  /** https://td.monolit-crm.ru */
  portal: string;
  /** https://monolitika.mlt-it.ru */
  app: string;
}

export function requestUrl(app: string, id: number): string {
  return `${app}/logist-kanban?request=${id}`;
}

const row = (cells: string[], head = false) => `[TR]${cells.map(c => `[TD]${head ? `[B]${c}[/B]` : c}[/TD]`).join('')}[/TR]`;

/** Описание задачи = шапка + таблица позиций, как у задач бизнес-процесса, + ссылка на запрос в Монолитике. */
export function taskDescription(r: RequestDetails, c: DescriptionCtx): string {
  const L: string[] = [];
  const mgr = r.manager.bitrixId
    ? `[URL=${c.portal}/company/personal/user/${r.manager.bitrixId}/]${bbSafe(r.manager.name ?? r.manager.bitrixId)}[/URL]`
    : dash(r.manager.name);
  L.push(`[B]Менеджер:[/B] ${mgr}`);
  L.push(`[B]Населенный пункт:[/B] ${bbSafe(dash(r.address))}`);
  L.push(`[B]Для каких целей:[/B] ${bbSafe(dash(r.purpose))}`);
  L.push(`[B]Форма оплаты:[/B] ${bbSafe(dash(r.paymentForm))}`);
  L.push(`[B]Дата поставки материала:[/B] ${ruDate(r.deliveryDate) ?? '-'}`);
  if (r.type === 'cheaper') {
    L.push(`[B]Конкурент:[/B] ${bbSafe(dash(r.competitorName))}`);
    if (r.competitorTotal != null) L.push(`[B]Сумма у конкурента:[/B] ${money(r.competitorTotal)} руб`);
  }
  const items = r.items;
  const goods = items.filter(i => !isService(i));
  const services = items.filter(isService);
  if (goods.length) {
    L.push('', '[B]Продукция из товаров:[/B]');
    L.push(`[TABLE]${row(['Товар', 'Кол-во', 'Наша цена', 'Сумма', 'Цена конкурента'], true)}${goods.map(i => row([
      bbSafe(i.name) + (i.comment ? ` (${bbSafe(i.comment)})` : ''),
      qty(i.quantity, i.measure),
      i.ourPrice != null ? `${num(i.ourPrice)} руб` : '-',
      i.ourSum != null ? `${money(i.ourSum)} руб` : '-',
      i.competitorPrice != null ? `${num(i.competitorPrice)} руб` : 'не указана',
    ])).join('')}[/TABLE]`);
  }
  if (services.length) {
    L.push('', '[B]Доставка и услуги:[/B]');
    L.push(`[TABLE]${row(['Наименование', 'Кол-во', 'Цена'], true)}${services.map(i => row([
      bbSafe(i.name), qty(i.quantity, i.measure), i.ourPrice != null ? `${num(i.ourPrice)} руб` : '-',
    ])).join('')}[/TABLE]`);
  }
  if (r.comment && r.comment.trim()) L.push('', `[B]Комментарий:[/B] ${bbSafe(r.comment.trim())}`);
  const goodsTotal = goods.reduce((s, i) => s + (i.ourSum ?? 0), 0);
  L.push('', `[B]Общая сумма по всем товарам:[/B] ${money(goodsTotal)} руб`);
  L.push(`[B]Общая сумма по сделке:[/B] ${r.deal?.amount != null ? `${money(r.deal.amount)} руб` : '-'}`);
  L.push('', `[B]Запрос в Монолитике:[/B] [URL=${requestUrl(c.app, r.id)}]№${r.id}[/URL] — ответ варианта, вопросы и возвраты ведутся там; эта задача — копия для отчётов.`);
  return L.join('\n');
}

/** Маркер запроса в описании — по нему синк находит уже созданную задачу, если ответ Битрикса потерялся. */
export function requestMarker(app: string, id: number): string {
  return requestUrl(app, id);
}

// ── комментарии в задачу ────────────────────────────────────────────────────────────────

const AVAIL: Record<OfferLine['availability'], string> = { ok: '', none: ' — [B]нет в наличии[/B]', analog: ' — [B]аналог[/B]' };

/** Ответ логиста вариантом — комментарием (таблицы в чате задачи не рисуются — строками). */
export function offerComment(o: Offer): string {
  const L: string[] = [`[B]Вариант №${o.n}[/B]`];
  const head = [
    o.supplier && `Поставщик: ${bbSafe(o.supplier)}`, o.paymentForm && `Оплата: ${bbSafe(o.paymentForm)}`,
    o.leadTime && `Срок: ${bbSafe(o.leadTime)}`, o.readyDate && `Готовность: ${ruDate(o.readyDate) ?? o.readyDate}`,
  ].filter(Boolean);
  if (head.length) L.push(head.join(' · '));
  for (const l of o.lines) {
    const price = l.price != null ? `${num(l.price)} руб` : 'цена —';
    const sum = l.sum != null ? ` = ${money(l.sum)} руб` : '';
    L.push(`• ${bbSafe(l.name)}: ${qty(l.quantity, l.measure)} × ${price}${sum}${AVAIL[l.availability]}${l.comment ? ` (${bbSafe(l.comment)})` : ''}`);
  }
  if (o.deliveryTotal > 0 || o.deliveryTrucks) {
    L.push(`Доставка: ${o.deliveryTrucks ?? 1} маш. × ${money(o.deliveryPrice ?? 0)} = ${money(o.deliveryTotal)} руб`);
  }
  L.push(`[B]Итого: ${money(o.total)} руб[/B] (товары ${money(o.goodsTotal)}${o.deliveryTotal ? `, доставка ${money(o.deliveryTotal)}` : ''})`);
  if (o.comment && o.comment.trim()) L.push(`Комментарий: ${bbSafe(o.comment.trim())}`);
  if (o.files.length) L.push(`Файлы (${o.files.length}) — в карточке запроса в Монолитике.`);
  return L.join('\n');
}

export function itemsAddedComment(items: RequestItem[]): string {
  return ['[B]Добавлены позиции:[/B]', ...items.map(i => `• ${bbSafe(i.name)}: ${qty(i.quantity, i.measure)}${i.ourPrice != null ? ` × ${num(i.ourPrice)} руб` : ''}`)].join('\n');
}

/** Сообщение чата → комментарий. Файлы в задачи нового вида через task.commentitem.add не доходят
 *  (BACKLOG, канбан больших чеков 18.11) — их не шлём, а честно пишем, где смотреть. */
export function messageComment(body: string, filesCount: number, authorPrefix: string | null): string {
  const text = bbSafe(body.trim());
  const files = filesCount ? `\n[I]Файлы (${filesCount}) — в карточке запроса в Монолитике.[/I]` : '';
  return `${authorPrefix ? `[B]${bbSafe(authorPrefix)}[/B] (из Монолитики):\n` : ''}${text || 'Файлы'}${files}`;
}

// ── «Принять вариант» → строки товаров сделки ───────────────────────────────────────────

/** Строка crm.deal.productrows.get (поля, которые возвращаем обратно при set). */
export interface BxProductRow {
  ID?: string | number; PRODUCT_ID?: string | number | null; PRODUCT_NAME?: string | null;
  PRICE?: string | number | null; PRICE_EXCLUSIVE?: string | number | null; PRICE_NETTO?: string | number | null; PRICE_BRUTTO?: string | number | null;
  QUANTITY?: string | number | null; DISCOUNT_TYPE_ID?: string | number | null; DISCOUNT_RATE?: string | number | null; DISCOUNT_SUM?: string | number | null;
  TAX_RATE?: string | number | null; TAX_INCLUDED?: string | null; CUSTOMIZED?: string | null;
  MEASURE_CODE?: string | number | null; MEASURE_NAME?: string | null; SORT?: string | number | null;
}
/** Строка для crm.deal.productrows.set. */
export type BxRowInput = Record<string, string | number>;

const KEEP_FIELDS: (keyof BxProductRow)[] = [
  'PRODUCT_ID', 'PRODUCT_NAME', 'PRICE', 'PRICE_EXCLUSIVE', 'PRICE_NETTO', 'PRICE_BRUTTO', 'QUANTITY',
  'DISCOUNT_TYPE_ID', 'DISCOUNT_RATE', 'DISCOUNT_SUM', 'TAX_RATE', 'TAX_INCLUDED', 'CUSTOMIZED', 'MEASURE_CODE', 'MEASURE_NAME',
];
/** Коды ОКЕИ единиц Битрикса (каталог портала: шт 796, м2 055 …). Неизвестная — только MEASURE_NAME. */
const MEASURE_CODES: Record<string, number> = {
  'шт': 796, 'м': 6, 'пм': 18, 'п.м': 18, 'м2': 55, 'м²': 55, 'м3': 113, 'м³': 113, 'кг': 166, 'т': 168, 'л': 112, 'упак': 778, 'уп': 778,
};
const normMeasure = (m: string | null | undefined) => (m ?? '').trim().toLowerCase().replace(/\.$/, '');
const n0 = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

export function viewOfBx(r: BxProductRow): DealRowView {
  const quantity = n0(r.QUANTITY), price = n0(r.PRICE);
  return {
    rowId: r.ID != null ? Number(r.ID) || null : null,
    productId: r.PRODUCT_ID != null && Number(r.PRODUCT_ID) > 0 ? Number(r.PRODUCT_ID) : null,
    name: String(r.PRODUCT_NAME ?? '').trim(), quantity, measure: r.MEASURE_NAME ?? null, price,
    sum: Math.round(quantity * price * 100) / 100,
  };
}

function keepInput(r: BxProductRow): BxRowInput {
  const out: BxRowInput = {};
  for (const k of KEEP_FIELDS) { const v = r[k]; if (v !== null && v !== undefined && v !== '') out[k] = v as string | number; }
  return out;
}

/** Отпечаток строк сделки (сверка предпросмотра с моментом записи). FNV-1a, без крипто — клиентобезопасно. */
export function rowsHash(rows: BxProductRow[]): string {
  const s = rows.map(r => [r.ID, r.PRODUCT_ID, r.PRODUCT_NAME, n0(r.QUANTITY), n0(r.PRICE)].join('\u0001')).join('\u0002');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0') + ':' + rows.length;
}

const DELIVERY_RE = /^(доставка|перевозка)/i;

export interface DealRowsPlan {
  rows: BxRowInput[];
  after: DealRowView[];
  changes: DealRowChange[];
  warnings: string[];
}

/**
 * Что станет с товарами сделки после «Принять вариант»:
 * - строка сделки, на которую ссылается позиция запроса с ответом в варианте (ok/analog), заменяется строками
 *   варианта по этой позиции (на том же месте); «нет в наличии» — строка сделки остаётся как была (предупреждение);
 * - строки сделки, которых запрос не касался, остаются как есть (со скидками/НДС — поля возвращаются в set);
 * - новые позиции логиста и свободные позиции запроса — добавляются в конец, без товара каталога (PRODUCT_NAME);
 * - доставка варианта (машины × цена) заменяет первую строку «Доставка…» сделки, иначе добавляется строкой.
 */
export function planDealRows(before: BxProductRow[], items: RequestItem[], offer: Offer): DealRowsPlan {
  const warnings: string[] = [];
  const itemById = new Map(items.map(i => [i.id, i]));
  const live = offer.lines.filter(l => l.availability !== 'none');
  for (const l of offer.lines) if (l.availability === 'none') {
    const it = l.itemId != null ? itemById.get(l.itemId) : null;
    warnings.push(`«${it?.name ?? l.name}» — нет в наличии: ${it?.bxRowId ? 'строка сделки останется как была' : 'в сделку не попадёт'}`);
  }
  const beforeIds = new Set(before.map(r => Number(r.ID)).filter(Boolean));
  // строки варианта, привязанные к строке сделки: rowId → строки
  const byRow = new Map<number, OfferLine[]>();
  const tail: OfferLine[] = [];
  for (const l of live) {
    const it = l.itemId != null ? itemById.get(l.itemId) : null;
    const rid = it?.bxRowId ?? null;
    if (rid && beforeIds.has(rid)) (byRow.get(rid) ?? byRow.set(rid, []).get(rid)!).push(l);
    else tail.push(l);
  }

  const rows: BxRowInput[] = [], after: DealRowView[] = [], changes: DealRowChange[] = [];
  const lineInput = (l: OfferLine, base: BxProductRow | null): { input: BxRowInput; view: DealRowView } => {
    const it = l.itemId != null ? itemById.get(l.itemId) : null;
    const productId = l.bxProductId ?? (l.availability === 'ok' ? it?.bxProductId ?? null : null);
    let quantity = l.quantity ?? it?.quantity ?? null;
    if (quantity == null || quantity <= 0) { warnings.push(`«${l.name}» — нет количества, записано 1`); quantity = 1; }
    let price = l.price;
    if (price == null) { warnings.push(`«${l.name}» — нет цены, записано 0`); price = 0; }
    const measure = l.measure ?? it?.measure ?? null;
    const input: BxRowInput = { PRODUCT_NAME: l.name.trim().slice(0, 255), PRICE: price, QUANTITY: quantity };
    // цена логиста, не каталожная: CUSTOMIZED=Y (как у строк, которые менеджер правит руками)
    if (productId) { input.PRODUCT_ID = productId; input.CUSTOMIZED = 'Y'; }
    const code = base && normMeasure(base.MEASURE_NAME) === normMeasure(measure) && base.MEASURE_CODE ? Number(base.MEASURE_CODE) : MEASURE_CODES[normMeasure(measure)];
    if (code) input.MEASURE_CODE = code;
    if (measure) input.MEASURE_NAME = measure;
    if (base?.TAX_RATE != null && base.TAX_RATE !== '') { input.TAX_RATE = n0(base.TAX_RATE); if (base.TAX_INCLUDED) input.TAX_INCLUDED = base.TAX_INCLUDED; }
    return { input, view: { rowId: null, productId: productId ?? null, name: l.name.trim(), quantity, measure, price, sum: Math.round(quantity * price * 100) / 100 } };
  };
  const delivery = offer.deliveryTotal > 0
    ? { trucks: offer.deliveryTrucks && offer.deliveryTrucks > 0 ? offer.deliveryTrucks : 1, price: offer.deliveryPrice ?? offer.deliveryTotal }
    : null;
  const deliveryRow = (base: BxProductRow | null): { input: BxRowInput; view: DealRowView } => {
    const name = base?.PRODUCT_NAME?.trim() || 'Доставка';
    const input: BxRowInput = { PRODUCT_NAME: name, PRICE: delivery!.price, QUANTITY: delivery!.trucks, MEASURE_CODE: 796, MEASURE_NAME: 'шт' };
    if (base?.PRODUCT_ID && Number(base.PRODUCT_ID) > 0) { input.PRODUCT_ID = Number(base.PRODUCT_ID); input.CUSTOMIZED = 'Y'; }
    return { input, view: { rowId: null, productId: input.PRODUCT_ID ? Number(input.PRODUCT_ID) : null, name, quantity: delivery!.trucks, measure: 'шт', price: delivery!.price, sum: Math.round(delivery!.trucks * delivery!.price * 100) / 100 } };
  };

  let deliveryPlaced = false;
  for (const b of before) {
    const bv = viewOfBx(b);
    const lines = bv.rowId ? byRow.get(bv.rowId) : undefined;
    if (lines?.length) {
      lines.forEach((l, i) => {
        const x = lineInput(l, b);
        rows.push(x.input); after.push(x.view);
        changes.push(i === 0
          ? { kind: 'replace', before: bv, after: x.view, note: l.availability === 'analog' ? 'аналог' : null }
          : { kind: 'add', before: null, after: x.view, note: `ещё строка варианта по «${bv.name}»` });
      });
      continue;
    }
    if (delivery && !deliveryPlaced && DELIVERY_RE.test(bv.name)) {
      const x = deliveryRow(b);
      rows.push(x.input); after.push(x.view);
      changes.push({ kind: 'replace', before: bv, after: x.view, note: 'доставка из варианта' });
      deliveryPlaced = true;
      continue;
    }
    rows.push(keepInput(b)); after.push(bv);
    changes.push({ kind: 'keep', before: bv, after: bv, note: null });
  }
  for (const l of tail) {
    const x = lineInput(l, null);
    rows.push(x.input); after.push(x.view);
    changes.push({ kind: 'add', before: null, after: x.view, note: x.input.PRODUCT_ID ? null : 'без товара каталога' });
  }
  if (delivery && !deliveryPlaced) {
    const x = deliveryRow(null);
    rows.push(x.input); after.push(x.view);
    changes.push({ kind: 'add', before: null, after: x.view, note: 'доставка из варианта' });
  }
  if (!live.length) warnings.push('В варианте нет ни одной позиции в наличии — товары сделки не изменятся');
  return { rows, after, changes, warnings };
}

export const rowsTotal = (rows: DealRowView[]) => Math.round(rows.reduce((s, r) => s + r.sum, 0) * 100) / 100;
