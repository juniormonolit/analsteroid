// Разбор и проверка тел запросов API (чистые функции). Всё, что пришло от клиента, проходит здесь:
// обрезка строк, числа в диапазоне, известные значения словарей. Ошибка — InputError с текстом для человека.
import {
  ACTION_KINDS, REQUEST_TYPES,
  type ActionBody, type Availability, type DraftHeaderInput, type ItemInput, type OfferInput, type OfferLineInput, type RequestType,
} from './contract';

export class InputError extends Error {}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {});
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function str(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' && typeof v !== 'number') throw new InputError('Ожидалась строка');
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
export function num(v: unknown, min: number, max: number, label: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').replace(/\s/g, ''));
  if (!Number.isFinite(n) || n < min || n > max) throw new InputError(`Некорректное значение: ${label}`);
  return n;
}
export function id(v: unknown, label: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 1e15) throw new InputError(`Некорректный ${label}`);
  return n;
}
const bitrixId = (v: unknown, label: string): string => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d{1,10}$/.test(s)) throw new InputError(`Некорректный ${label}`);
  return s;
};
const dateStr = (v: unknown, label: string): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new InputError(`Некорректная дата: ${label}`);
  return v;
};
const ids = (v: unknown): number[] => (Array.isArray(v) ? [...new Set(v.map(x => id(x, 'id файла')))].slice(0, 20) : []);

export function parseType(v: unknown): RequestType {
  if (!REQUEST_TYPES.includes(v as RequestType)) throw new InputError('Тип запроса: supply или cheaper');
  return v as RequestType;
}

/** Только переданные ключи (частичное обновление): undefined — не трогать, null — очистить. */
export function parseHeader(raw: unknown): DraftHeaderInput {
  const r = obj(raw);
  const h: DraftHeaderInput = {};
  if (has(r, 'type')) h.type = parseType(r.type);
  if (has(r, 'queueId')) h.queueId = r.queueId === null ? null : id(r.queueId, 'id очереди');
  if (has(r, 'address')) h.address = str(r.address, 500);
  if (has(r, 'purpose')) h.purpose = str(r.purpose, 500);
  if (has(r, 'paymentForm')) h.paymentForm = str(r.paymentForm, 200);
  if (has(r, 'deliveryDate')) h.deliveryDate = dateStr(r.deliveryDate, 'дата поставки');
  if (has(r, 'comment')) h.comment = str(r.comment, 4000);
  if (has(r, 'competitorName')) h.competitorName = str(r.competitorName, 300);
  if (has(r, 'competitorTotal')) h.competitorTotal = num(r.competitorTotal, 0, 1e12, 'цена конкурента');
  return h;
}

export function parseItems(raw: unknown): ItemInput[] {
  if (!Array.isArray(raw)) throw new InputError('Позиции — список');
  if (raw.length > 200) throw new InputError('Слишком много позиций (больше 200)');
  return raw.map((x, i) => {
    const r = obj(x);
    const name = str(r.name, 500);
    if (!name) throw new InputError(`Позиция ${i + 1}: нужно наименование`);
    const kind = r.kind === 'deal_row' ? 'deal_row' : 'free';
    return {
      ...(r.id !== undefined && r.id !== null ? { id: id(r.id, 'id позиции') } : {}),
      kind,
      bxRowId: r.bxRowId == null ? null : id(r.bxRowId, 'id строки сделки'),
      bxProductId: r.bxProductId == null ? null : id(r.bxProductId, 'id товара'),
      name,
      quantity: num(r.quantity, 0, 1e9, `кол-во, позиция ${i + 1}`),
      measure: str(r.measure, 40),
      ourPrice: num(r.ourPrice, 0, 1e12, `цена, позиция ${i + 1}`),
      productGroup: str(r.productGroup, 200),
      competitorPrice: num(r.competitorPrice, 0, 1e12, `цена конкурента, позиция ${i + 1}`),
      comment: str(r.comment, 2000),
      fileIds: ids(r.fileIds),
    };
  });
}

const AVAIL: readonly Availability[] = ['ok', 'none', 'analog'];

export function parseOffer(raw: unknown): OfferInput {
  const r = obj(raw);
  if (!Array.isArray(r.lines) || !r.lines.length) throw new InputError('В варианте нужна хотя бы одна строка');
  if (r.lines.length > 200) throw new InputError('Слишком много строк в варианте');
  const lines: OfferLineInput[] = r.lines.map((x, i) => {
    const l = obj(x);
    const name = str(l.name, 500);
    if (!name) throw new InputError(`Строка ${i + 1}: нужно наименование`);
    const availability = l.availability === undefined ? 'ok' : l.availability as Availability;
    if (!AVAIL.includes(availability)) throw new InputError(`Строка ${i + 1}: наличие ok / none / analog`);
    return {
      itemId: l.itemId == null ? null : id(l.itemId, 'id позиции'),
      availability, name,
      bxProductId: l.bxProductId == null ? null : id(l.bxProductId, 'id товара'),
      quantity: num(l.quantity, 0, 1e9, `кол-во, строка ${i + 1}`),
      measure: str(l.measure, 40),
      price: num(l.price, 0, 1e12, `цена, строка ${i + 1}`),
      comment: str(l.comment, 2000),
    };
  });
  return {
    supplier: str(r.supplier, 300), paymentForm: str(r.paymentForm, 200),
    leadTime: str(r.leadTime, 200), readyDate: dateStr(r.readyDate, 'срок'),
    deliveryTrucks: num(r.deliveryTrucks, 0, 1000, 'машины'), deliveryPrice: num(r.deliveryPrice, 0, 1e9, 'цена доставки'),
    comment: str(r.comment, 4000), lines, fileIds: ids(r.fileIds),
  };
}

/** Тело POST …/action → ActionBody. */
export function parseAction(raw: unknown): ActionBody {
  const r = obj(raw);
  const action = r.action;
  if (!ACTION_KINDS.includes(action as never)) throw new InputError('Неизвестное действие');
  const version = r.version == null ? undefined : Number(r.version);
  if (version !== undefined && !Number.isInteger(version)) throw new InputError('Некорректная версия');
  const v = version === undefined ? {} : { version };
  switch (action) {
    case 'update_draft':
      return { ...v, action, header: r.header === undefined ? undefined : parseHeader(r.header), items: r.items === undefined ? undefined : parseItems(r.items) };
    case 'send': case 'take':
      return { ...v, action };
    case 'release':
      return { ...v, action, comment: str(r.comment, 2000) ?? undefined };
    case 'transfer':
      return { ...v, action, queueId: id(r.queueId, 'id очереди'), comment: str(r.comment, 2000) ?? undefined };
    case 'reassign':
      return { ...v, action, logistBitrixId: bitrixId(r.logistBitrixId, 'логист'), logistName: str(r.logistName, 200), comment: str(r.comment, 2000) ?? undefined };
    case 'answer':
      return { ...v, action, offer: parseOffer(r.offer) };
    case 'withdraw_offer':
      return { ...v, action, offerId: id(r.offerId, 'id варианта') };
    case 'return': {
      const comment = str(r.comment, 4000);
      if (!comment) throw new InputError('Напишите, что доработать');
      return { ...v, action, comment };
    }
    case 'accept': {
      const dr = r.dealRows && typeof r.dealRows === 'object' ? r.dealRows as Record<string, unknown> : null;
      const dealRows = dr && dr.confirm === true && typeof dr.hash === 'string' && dr.hash.length <= 64
        ? { confirm: true as const, hash: dr.hash } : undefined;
      return { ...v, action, offerId: id(r.offerId, 'id варианта'), ...(dealRows ? { dealRows } : {}) };
    }
    case 'cancel':
      return { ...v, action, reason: str(r.reason, 2000) ?? undefined };
    case 'add_items': {
      const items = parseItems(r.items);
      if (!items.length) throw new InputError('Нет позиций');
      return { ...v, action, items };
    }
  }
  throw new InputError('Неизвестное действие');
}

// ── расчёты варианта ────────────────────────────────────────────────────────────────────

const money = (x: number) => Math.round(x * 100) / 100;

/** Суммы строк и итоги варианта: строки «нет в наличии» в сумму не идут. */
export function offerTotals(o: Pick<OfferInput, 'lines' | 'deliveryTrucks' | 'deliveryPrice'>): {
  lineSums: (number | null)[]; goodsTotal: number; deliveryTotal: number; total: number;
} {
  const lineSums = o.lines.map(l => (l.quantity != null && l.price != null ? money(l.quantity * l.price) : null));
  const goodsTotal = money(o.lines.reduce((a, l, i) => a + (l.availability === 'none' ? 0 : lineSums[i] ?? 0), 0));
  const deliveryTotal = money((o.deliveryTrucks ?? 0) * (o.deliveryPrice ?? 0));
  return { lineSums, goodsTotal, deliveryTotal, total: money(goodsTotal + deliveryTotal) };
}

/** Проверка перед отправкой черновика. Возвращает список проблем (пусто — можно отправлять). */
export function sendProblems(r: {
  type: RequestType; queueId: number | null; competitorTotal: number | null;
  items: { name: string; competitorPrice: number | null; removed?: boolean }[];
}): string[] {
  const out: string[] = [];
  const items = r.items.filter(i => !i.removed);
  if (!r.queueId) out.push('Не выбрана очередь (проект логистов)');
  if (!items.length) out.push('Нет ни одной позиции');
  if (r.type === 'cheaper' && r.competitorTotal == null && !items.some(i => i.competitorPrice != null)) {
    out.push('Для «Есть цена дешевле» укажите цену конкурента — по позициям или общую');
  }
  return out;
}
