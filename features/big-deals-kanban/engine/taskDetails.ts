// Открытая карточка задачи канбана больших чеков: описание, товары сделки, чат задачи.
// Всё — чтение Битрикса по запросу (открыли карточку), на доску не влияет.
import { bx } from '@/lib/bitrix/notify';
import { read, taskWebhook } from '@/features/repeat-kanban/engine/createDeal';
import { stripBb } from '@/features/repeat-kanban/engine/taskNotes';
import type { BxBigTask } from './actions';
import { buildBrief, type BigTaskBrief, type BriefDeal } from './taskBrief';

export interface BigChatMessage { id: number; author: string | null; authorId: string; at: string; text: string; system: boolean;
  /** Исходный BB-текст (даты [TIMESTAMP] уже подставлены) — лента рисует ссылки/жирный/упоминания (ui/BbText). */
  bb?: string; /** Вложенные файлы (картинки и т.п.): имя и ссылка на просмотр в Битриксе. */ files?: BigChatFile[] }
/** Файл из чата задачи. Вебхуку Битрикс не отдаёт ни имя, ни сам файл (disk.file.get — «нет доступа», проверено 23.11),
 *  поэтому ссылка ведёт в Битрикс (/disk/showFile/{id}/) — откроется у того, кто залогинен в Битриксе и видит чат. */
export interface BigChatFile { name: string; url: string | null }
export interface BigDealProduct { name: string; qty: number; price: number; sum: number; unit: string | null }
export interface BigTaskDetails {
  taskId: number;
  status: string;
  taskControl: boolean;
  responsibleId: string | null;
  creatorId: string | null;
  /** Описание без BB-кодов (переносы строк сохранены). */
  description: string;
  /** Разобранные поля описания: «Клиент», «Товары», «Цели», «Есть ли цена дешевле», «Дата поставки…». */
  fields: { label: string; value: string }[];
  /** Строки товаров из описания задачи. */
  taskProducts: string[];
  /** Вопросы менеджеру из описания («1. Когда нужен материал…») — из полей вырезаны, показываются кнопками у чата. */
  questions: string[];
  /** Сделка задачи и первый телефон её контакта/компании (crm.contact.get / crm.company.get). */
  dealId: number | null;
  phone: string | null;
  /** РОП исполнителя по оргструктуре (sa.org_resolved_hierarchy) — кнопка «Отметить РОПа» в чате (роут дописывает). */
  rop?: { id: string; name: string } | null;
  dealProducts: BigDealProduct[] | null;
  /** Товары сделки не совпадают с товарами из описания (по названиям). */
  productsChanged: boolean;
  chat: BigChatMessage[];
  /** «Задача» целиком: поля описания + сделки + запросов логисту, товары при постановке, цена конкурента (taskBrief.ts). */
  brief?: BigTaskBrief;
  /** Участники задачи из Битрикса (свежие, не из снимка доски). */
  auditors: string[];
  accomplices: string[];
  /** Кто смотрит: Bitrix id и может ли управлять ЭТОЙ задачей (роут дописывает). */
  viewer?: { id: string | null; canManage: boolean };
}

export interface BxTaskFull extends BxBigTask { description?: string; chatId?: number | string | null }

const crmWebhook = () => (process.env.BITRIX_WEBHOOK_URL_2 || process.env.BITRIX_WEBHOOK_URL || '').replace(/\/+$/, '');

/** «[b]Клиент: [/b]Максим» → поля; «Товары:» — многострочное до следующего «[b]…:». */
export function parseDescription(raw: string): { fields: { label: string; value: string }[]; taskProducts: string[]; questions: string[] } {
  const fields: { label: string; value: string }[] = [];
  // Вопросы — нумерованные строки «1. …» после полей (сверено 18.11 на 179058/179059: «1. Когда нужен материал / …»,
  // «5. Какие следующие договоренности»). Вырезаем их из значений, чтобы не было двух блоков вопросов (РОП 18.11).
  const questions: string[] = [];
  const QRE = /^\s*\d{1,2}[.)]\s+(.{3,300})$/;
  const dropQuestions = (v: string) => v.split('\n').filter(line => {
    const q = QRE.exec(stripBb(line));
    if (q) { const t = q[1].trim(); if (!questions.includes(t)) questions.push(t); return false; }
    return true;
  }).join('\n');
  const re = /\[b\]\s*([^\[\]:]{2,60}):\s*\[\/b\]([\s\S]*?)(?=\[b\]\s*[^\[\]:]{2,60}:\s*\[\/b\]|$)/gi;
  let m: RegExpExecArray | null;
  // В «Товарах» нумерацию не трогаем — там строки позиций, не вопросы.
  while ((m = re.exec(raw))) fields.push({ label: m[1].trim(), value: (/^товары/i.test(m[1].trim()) ? (x: string) => x : dropQuestions)(stripBb(m[2].replace(/\r/g, ''))).replace(/https?:\/\/\S+\/crm\/deal\/details\/\d+\/?/g, '').trim() });
  const goods = fields.find(f => /^товары/i.test(f.label));
  const taskProducts = (goods?.value ?? '').split('\n').map(s => s.trim()).filter(s => s && !/^общая сумма/i.test(s));
  return { fields, taskProducts, questions };
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();

export function productsDiffer(taskProducts: string[], deal: BigDealProduct[] | null): boolean {
  if (!deal || !taskProducts.length) return false;
  const inTask = taskProducts.map(norm);
  const dealNames = deal.map(p => norm(p.name)).filter(Boolean);
  if (dealNames.length !== inTask.length) return true;
  return dealNames.some(n => !inTask.some(t => t.startsWith(n) || t.includes(n)));
}

export async function fetchTaskDetails(t: BxTaskFull, dealId: number | null): Promise<BigTaskDetails> {
  const raw = String(t.description ?? '');
  const { fields, taskProducts, questions } = parseDescription(raw);
  const dealRow = dealId ? await fetchDeal(dealId).catch(() => null) : null;
  const [dealProducts, phone, chat, relatedDescriptions] = await Promise.all([
    dealId ? fetchDealProducts(dealId) : Promise.resolve(null),
    dealRow ? fetchClientPhone(dealRow).catch(() => null) : Promise.resolve(null),
    t.chatId ? fetchChat(Number(t.chatId)).catch(e => { console.warn('[big-deals details] чат', e instanceof Error ? e.message : e); return [] as BigChatMessage[]; }) : Promise.resolve([] as BigChatMessage[]),
    dealId ? fetchRelatedDescriptions(dealId, Number(t.id)).catch(() => [] as string[]) : Promise.resolve([] as string[]),
  ]);
  const brief = buildBrief({
    descFields: fields, taskProductLines: taskProducts, relatedDescriptions,
    deal: dealRow ? {
      ADDRESS: str(dealRow.UF_ADDRESS_COORDS_INPUT), PURPOSE: str(dealRow.UF_CRM_1789046051), DELIVERY: str(dealRow.UF_CRM_1744960397885),
      SOURCE: str(dealRow.SOURCE_DESCRIPTION), COMMENTS: str(dealRow.COMMENTS),
    } satisfies BriefDeal : null,
  });
  return {
    taskId: Number(t.id),
    status: String(t.status ?? ''),
    taskControl: String(t.taskControl ?? '').toUpperCase() === 'Y',
    responsibleId: t.responsibleId ? String(t.responsibleId) : null,
    creatorId: t.createdBy ? String(t.createdBy) : null,
    description: stripBb(raw).slice(0, 8000),
    fields,
    taskProducts,
    questions,
    dealId,
    phone,
    dealProducts,
    productsChanged: productsDiffer(taskProducts, dealProducts),
    chat,
    brief,
    auditors: (t.auditors ?? []).map(String),
    accomplices: (t.accomplices ?? []).map(String),
  };
}

async function fetchDealProducts(dealId: number): Promise<BigDealProduct[] | null> {
  const w = crmWebhook();
  if (!w) return null;
  const res = await bx(w, 'crm.deal.productrows.get', { id: dealId }).catch(() => null) as { result?: { PRODUCT_NAME: string; QUANTITY: number | string; PRICE: number | string; MEASURE_NAME?: string | null }[] } | null;
  if (!res?.result) return null;
  return res.result.map(p => {
    const qty = Number(p.QUANTITY) || 0, price = Number(p.PRICE) || 0;
    return { name: String(p.PRODUCT_NAME ?? ''), qty, price, sum: Math.round(qty * price), unit: p.MEASURE_NAME ?? null };
  });
}

type DealRow = Record<string, unknown> & { CONTACT_ID?: string | null; COMPANY_ID?: string | null };
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

async function fetchDeal(dealId: number): Promise<DealRow | null> {
  const w = crmWebhook();
  if (!w) return null;
  const r = await bx(w, 'crm.deal.get', { id: dealId }) as { result?: DealRow };
  return r.result ?? null;
}

/** Описания других задач по сделке (запросы логисту/снабжению) — форма оплаты, комментарий менеджера, цена конкурента. */
async function fetchRelatedDescriptions(dealId: number, selfId: number): Promise<string[]> {
  const r = await read<{ tasks?: { id: string; description?: string }[] }>('tasks.task.list', {
    filter: { UF_CRM_TASK: `D_${dealId}` }, select: ['ID', 'DESCRIPTION'], order: { ID: 'desc' },
  });
  return (r?.tasks ?? []).filter(x => Number(x.id) !== selfId).map(x => String(x.description ?? '')).filter(Boolean).slice(0, 10);
}

/** Первый телефон клиента сделки: контакт, нет — компания. Только чтение CRM, лениво при открытии карточки. */
async function fetchClientPhone(deal: DealRow): Promise<string | null> {
  const w = crmWebhook();
  if (!w) return null;
  const first = (r: unknown) => {
    const list = (r as { result?: { PHONE?: { VALUE?: string }[] } } | null)?.result?.PHONE ?? [];
    return list.map(p => String(p.VALUE ?? '').trim()).find(Boolean) ?? null;
  };
  const contactId = Number(deal.CONTACT_ID) || 0;
  if (contactId) { const p = first(await bx(w, 'crm.contact.get', { id: contactId }).catch(() => null)); if (p) return p; }
  const companyId = Number(deal.COMPANY_ID) || 0;
  if (companyId) return first(await bx(w, 'crm.company.get', { id: companyId }).catch(() => null));
  return null;
}

interface ImMessage { id: number; author_id: number; date: string; text: string; params?: { FILE_ID?: (number | string)[] } | null }
interface ImUser { id: number; name: string }
interface ImFile { id: number | string; name?: string }

/** Просмотр файла Диска в Битриксе (портал — из вебхука задач). Нет портала — без ссылки. */
function fileUrl(id: number | string): string | null {
  if (!/^\d{1,12}$/.test(String(id))) return null;
  try { return `${new URL(taskWebhook()).origin}/disk/showFile/${id}/?&ncc=1`; } catch { return null; }
}

/** [TIMESTAMP=1795531800 FORMAT=LONG_DATE_FORMAT], [TIMESTAMP=… FORMAT=SHORT_TIME_FORMAT] → «25.11.2026, 17:50» (МСК).
 *  Раньше stripBb вырезал их в пустоту: «установил крайний срок задачи на , » (Fable 25.11, аудит п.5). */
export function fillTimestamps(raw: string): string {
  return raw.replace(/\[TIMESTAMP=(\d{9,11})(?:\s+FORMAT=([A-Z_]+))?\]/g, (_m, ts: string, fmt?: string) => {
    const d = new Date(Number(ts) * 1000);
    if (fmt && /TIME/.test(fmt) && !/DATE/.test(fmt)) return d.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
    if (fmt && /DATE/.test(fmt) && !/TIME/.test(fmt)) return d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
    return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  });
}

export async function fetchChat(chatId: number): Promise<BigChatMessage[]> {
  const r = await read<{ messages?: ImMessage[]; users?: ImUser[]; files?: ImFile[] | Record<string, ImFile> }>('im.dialog.messages.get', { DIALOG_ID: `chat${chatId}`, LIMIT: 50 });
  const users = new Map((r?.users ?? []).map(u => [Number(u.id), u.name]));
  // files — массив или объект по id (PHP); вебхуку без доступа к файлам Битрикс отдаёт пусто — тогда «файл».
  const fileList = Array.isArray(r?.files) ? r.files : Object.values(r?.files ?? {});
  const fileNames = new Map(fileList.map(f => [Number(f.id), f.name ?? 'файл']));
  // Сообщение с одной картинкой — пустой текст + params.FILE_ID. Раньше такие отбрасывались, и фото в ленте
  // Монолитики не было вовсе (18.11, РОП Осипов: «фотка не отправилась»).
  return (r?.messages ?? [])
    .map(m => ({ m, bb: fillTimestamps(m.text ?? ''), files: (m.params?.FILE_ID ?? []).map(id => ({ name: fileNames.get(Number(id)) ?? 'файл', url: fileUrl(id) })) }))
    .map(x => ({ ...x, text: stripBb(x.bb) }))
    .filter(x => x.text.length > 0 || x.files.length > 0)
    .sort((a, b) => a.m.date.localeCompare(b.m.date))
    .map(({ m, text, bb, files }) => ({
      id: m.id, author: users.get(m.author_id) ?? null, authorId: String(m.author_id),
      at: new Date(m.date).toISOString(), text: text.slice(0, 3000), bb: bb.slice(0, 4000), system: m.author_id === 0,
      ...(files.length ? { files } : {}),
    }));
}
