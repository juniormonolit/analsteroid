// «Задача» в карточке (владелец 25.11: «информацию из задачи не только товары переносить, но и прочие комментарии и
// уточнения — чтобы не хотелось проваливаться в Битрикс»; спецификация Fable 25.11, раздел 4).
// Источники (сверено 25.11 на задаче 180929 / сделке 282652):
//  • описание большой задачи — «[b]Клиент:[/b] …, [b]Товары:[/b] строки «Товар 58.5 м3 по 5100 руб. (298350 руб.)»,
//    [b]Цели:[/b], [b]Есть ли цена дешевле:[/b], [b]Дата поставки материала:[/b]»;
//  • сделка — адрес (UF_ADDRESS_COORDS_INPUT), «Для каких целей» (UF_CRM_1789046051), дата поставки (UF_CRM_1744960397885),
//    комментарий колл-центра (COMMENTS);
//  • описания связанных задач логиста/снабжения по сделке (бизнес-процесс, 181102): «[B]Форма оплаты:[/B] Нал»,
//    «[B]Комментарий:[/B] есть дешевле. 1 сорт» (комментарий менеджера), таблица товаров с колонкой «Цена конкурента».
// Только чтение Битрикса, при открытии карточки.
import { parseBb, type Inline } from './bb';

export interface BigBriefProduct { name: string; qty: number | null; unit: string | null; price: number | null; sum: number | null }
export interface BigTaskBrief {
  /** Поля «подпись — значение», пустые и «-» выброшены; warn — дата поставки сегодня/завтра или прошла. */
  fields: { label: string; value: string; warn?: boolean }[];
  /** Комментарий менеджера из запроса логисту/снабжению — суть («есть дешевле. 1 сорт»). */
  managerComment: string | null;
  /** Товары из описания большой задачи (как было при постановке). */
  taskProducts: BigBriefProduct[];
  taskTotal: number | null;
  /** Цена конкурента из запросов (значения ≤ 1 ₽ — заглушка, выброшены). */
  competitor: { name: string; price: number }[];
  /** Заявка из колл-центра (комментарий сделки) — свёрнуто. */
  callCenter: string | null;
}

const num = (s: string | undefined | null): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/\s| /g, '').replace(',', '.').replace(/руб\.?|₽/gi, ''));
  return Number.isFinite(n) ? n : null;
};
const LINE = /^(.*?)\s+(\d+(?:[.,]\d+)?)\s+([^\s\d][^\s]*)\s+по\s+([\d\s ]+(?:[.,]\d+)?)\s*руб\.?\s*\(([\d\s ]+(?:[.,]\d+)?)\s*руб\.?\)\s*$/i;

/** «Газобетон СК D400 400х250х625 мм 58.5 м3 по 5100 руб. (298350 руб.)» → позиция; не разобрали — только название. */
export function parseProductLine(line: string): BigBriefProduct {
  const m = LINE.exec(line.trim());
  if (!m) return { name: line.trim(), qty: null, unit: null, price: null, sum: null };
  return { name: m[1].trim(), qty: num(m[2]), unit: m[3], price: num(m[4]), sum: num(m[5]) };
}

const text = (c: Inline[]): string => c.map(n => (n.t === 'text' ? n.v : n.t === 'br' ? '\n' : 'c' in n ? text(n.c) : '')).join('');

/** «[B]Поле:[/B] значение» из описания (BB) — однострочные значения. */
export function bbFields(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\[b\]\s*([^\[\]\n]{2,60}?)\s*:?\s*\[\/b\]\s*:?\s*([^\n]*)/gi;
  for (const m of raw.matchAll(re)) {
    const label = m[1].replace(/:$/, '').trim();
    const value = text(parseBb(m[2]).flatMap(b => (b.t === 'inline' ? b.c : []))).trim();
    if (!out.has(label.toLowerCase())) out.set(label.toLowerCase(), value);
  }
  return out;
}

/** Цена конкурента из таблиц описания (колонка с «конкурент» в шапке). */
export function competitorPrices(raw: string): { name: string; price: number }[] {
  const out: { name: string; price: number }[] = [];
  for (const b of parseBb(raw)) {
    if (b.t !== 'table' || b.rows.length < 2) continue;
    const head = b.rows[0].map(c => text(c).toLowerCase());
    const ci = head.findIndex(h => h.includes('конкурент'));
    if (ci < 0) continue;
    for (const r of b.rows.slice(1)) {
      const price = num(text(r[ci] ?? []));
      if (price && price > 1) out.push({ name: text(r[0] ?? []).trim(), price });
    }
  }
  return out;
}

const empty = (v: string | null | undefined) => !v || /^[-–—\s]*$/.test(v);
const mskDay = (iso: string) => new Date(Date.parse(iso) + 3 * 3600_000).toISOString().slice(0, 10);

export interface BriefDeal { ADDRESS?: string | null; PURPOSE?: string | null; DELIVERY?: string | null; COMMENTS?: string | null }

export function buildBrief(args: {
  descFields: { label: string; value: string }[];
  taskProductLines: string[];
  deal: BriefDeal | null;
  relatedDescriptions: string[];
}): BigTaskBrief {
  const { descFields, deal } = args;
  const fromDesc = (re: RegExp) => descFields.find(f => re.test(f.label))?.value?.trim() || null;
  const rel = args.relatedDescriptions.map(bbFields);
  const fromRel = (key: string) => rel.map(m => m.get(key)).find(v => !empty(v)) ?? null;

  const fields: BigTaskBrief['fields'] = [];
  const add = (label: string, value: string | null | undefined, warn?: boolean) => { if (!empty(value)) fields.push({ label, value: value!.trim(), ...(warn ? { warn } : {}) }); };

  add('Клиент', fromDesc(/^клиент/i));
  // «Париж» в адресе — самовывоз (правило проекта), не адрес доставки.
  const addr = (deal?.ADDRESS ?? '').split('||')[0].trim() || fromRel('населенный пункт') || fromRel('населённый пункт');
  add('Адрес', addr && /париж/i.test(addr) ? 'Самовывоз' : addr);
  add('Для каких целей', deal?.PURPOSE || fromDesc(/^цели/i) || fromRel('для каких целей'));
  add('Форма оплаты', fromRel('форма оплаты'));
  const dIso = deal?.DELIVERY ?? null;
  const dText = dIso ? new Date(dIso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : fromDesc(/дата поставки/i);
  const soon = dIso ? (Date.parse(`${mskDay(dIso)}T00:00:00Z`) - Date.parse(`${mskDay(new Date().toISOString())}T00:00:00Z`)) / 86_400_000 <= 1 : false;
  add('Дата поставки', dText, soon);
  add('Есть ли цена дешевле', fromDesc(/цена дешевле/i));
  // «Источник» (ссылка на Авито и т.п.) убран — владелец 25.11: «информация про источник в целом нахуй не нужна».

  const goods = args.taskProductLines.filter(l => !/^общая сумма/i.test(l));
  const totalLine = args.taskProductLines.find(l => /^общая сумма/i.test(l));
  return {
    fields,
    managerComment: fromRel('комментарий'),
    taskProducts: goods.map(parseProductLine),
    taskTotal: (totalLine ? num(totalLine.replace(/^общая сумма:?/i, '')) : null)
      ?? (goods.length && goods.every(l => parseProductLine(l).sum != null) ? goods.reduce((a, l) => a + (parseProductLine(l).sum ?? 0), 0) : null),
    competitor: args.relatedDescriptions.flatMap(competitorPrices),
    callCenter: deal?.COMMENTS?.trim() ? deal.COMMENTS.trim().slice(0, 3000) : null,
  };
}
