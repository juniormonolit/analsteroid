// Открытая карточка задачи канбана больших чеков: описание, товары сделки, чат задачи.
// Всё — чтение Битрикса по запросу (открыли карточку), на доску не влияет.
import { bx } from '@/lib/bitrix/notify';
import { read, taskWebhook } from '@/features/repeat-kanban/engine/createDeal';
import { stripBb } from '@/features/repeat-kanban/engine/taskNotes';
import type { BxBigTask } from './actions';

export interface BigChatMessage { id: number; author: string | null; authorId: string; at: string; text: string; system: boolean; /** Вложенные файлы (картинки и т.п.): имя и ссылка на просмотр в Битриксе. */ files?: BigChatFile[] }
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
  const [dealProducts, phone, chat] = await Promise.all([
    dealId ? fetchDealProducts(dealId) : Promise.resolve(null),
    dealId ? fetchClientPhone(dealId).catch(() => null) : Promise.resolve(null),
    t.chatId ? fetchChat(Number(t.chatId)).catch(e => { console.warn('[big-deals details] чат', e instanceof Error ? e.message : e); return [] as BigChatMessage[]; }) : Promise.resolve([] as BigChatMessage[]),
  ]);
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

/** Первый телефон клиента сделки: контакт, нет — компания. Только чтение CRM, лениво при открытии карточки. */
async function fetchClientPhone(dealId: number): Promise<string | null> {
  const w = crmWebhook();
  if (!w) return null;
  const deal = await bx(w, 'crm.deal.get', { id: dealId }).catch(() => null) as { result?: { CONTACT_ID?: string | null; COMPANY_ID?: string | null } } | null;
  const first = (r: unknown) => {
    const list = (r as { result?: { PHONE?: { VALUE?: string }[] } } | null)?.result?.PHONE ?? [];
    return list.map(p => String(p.VALUE ?? '').trim()).find(Boolean) ?? null;
  };
  const contactId = Number(deal?.result?.CONTACT_ID) || 0;
  if (contactId) { const p = first(await bx(w, 'crm.contact.get', { id: contactId }).catch(() => null)); if (p) return p; }
  const companyId = Number(deal?.result?.COMPANY_ID) || 0;
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

export async function fetchChat(chatId: number): Promise<BigChatMessage[]> {
  const r = await read<{ messages?: ImMessage[]; users?: ImUser[]; files?: ImFile[] | Record<string, ImFile> }>('im.dialog.messages.get', { DIALOG_ID: `chat${chatId}`, LIMIT: 50 });
  const users = new Map((r?.users ?? []).map(u => [Number(u.id), u.name]));
  // files — массив или объект по id (PHP); вебхуку без доступа к файлам Битрикс отдаёт пусто — тогда «файл».
  const fileList = Array.isArray(r?.files) ? r.files : Object.values(r?.files ?? {});
  const fileNames = new Map(fileList.map(f => [Number(f.id), f.name ?? 'файл']));
  // Сообщение с одной картинкой — пустой текст + params.FILE_ID. Раньше такие отбрасывались, и фото в ленте
  // Монолитики не было вовсе (18.11, РОП Осипов: «фотка не отправилась»).
  return (r?.messages ?? [])
    .map(m => ({ m, text: stripBb(m.text ?? ''), files: (m.params?.FILE_ID ?? []).map(id => ({ name: fileNames.get(Number(id)) ?? 'файл', url: fileUrl(id) })) }))
    .filter(x => x.text.length > 0 || x.files.length > 0)
    .sort((a, b) => a.m.date.localeCompare(b.m.date))
    .map(({ m, text, files }) => ({
      id: m.id, author: users.get(m.author_id) ?? null, authorId: String(m.author_id),
      at: new Date(m.date).toISOString(), text: text.slice(0, 3000), system: m.author_id === 0,
      ...(files.length ? { files } : {}),
    }));
}
