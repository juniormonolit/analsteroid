// Битрикс для «Увольнятора»: чтение — основной вебхук (BITRIX_WEBHOOK_URL: crm на чтение + task/user),
// запись CRM — BITRIX_WEBHOOK_URL_2 (crm на запись, как crmWebhook() в repeat-kanban/engine/createDeal.ts),
// запись задач и запуск БП — основной вебхук (taskWebhook()). Запись — writeOnce: без автоповторов,
// повтор после таймаута решает воркер, предварительно перечитав сущность (не задвоить).
import { bx } from '@/lib/bitrix/notify';
import { taskWebhook, writeOnce } from '@/features/repeat-kanban/engine/createDeal';

export const PORTAL = 'https://td.monolit-crm.ru';

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function crmWriteWebhook(): string {
  const w = process.env.BITRIX_WEBHOOK_URL_2 || process.env.BITRIX_WEBHOOK_URL || '';
  if (!w) throw new Error('Не задан вебхук Битрикса для записи CRM (BITRIX_WEBHOOK_URL_2)');
  return w.replace(/\/+$/, '');
}

/** Одна страница чтения: { result, next }. bx() сам повторяет QUERY_LIMIT_EXCEEDED/5xx (3 попытки). */
export async function readPage<T>(method: string, params: Record<string, unknown>): Promise<{ result: T; next: number | null; total: number | null }> {
  const body = await bx(taskWebhook(), method, params) as { result: T; next?: number; total?: number };
  return { result: body.result, next: typeof body.next === 'number' ? body.next : null, total: typeof body.total === 'number' ? body.total : null };
}

export async function readOne<T>(method: string, params: Record<string, unknown>): Promise<T> {
  return (await readPage<T>(method, params)).result;
}

/** Все страницы списка (start/next), пауза между страницами — Битрикс вежливо. */
export async function readAll<T>(
  method: string, params: Record<string, unknown>, opts: { pick?: (r: unknown) => T[]; pauseMs?: number; onPage?: () => Promise<void> | void } = {},
): Promise<T[]> {
  const out: T[] = [];
  let start: number | null = 0;
  const pick = opts.pick ?? ((r: unknown) => (Array.isArray(r) ? r as T[] : []));
  for (let guard = 0; start !== null && guard < 2000; guard++) {
    const page: { result: unknown; next: number | null } = await readPage<unknown>(method, { ...params, start });
    out.push(...pick(page.result));
    start = page.next;
    await opts.onPage?.();
    if (start !== null) await sleep(opts.pauseMs ?? 500);
  }
  return out;
}

export const writeCrm = <T>(method: string, params: Record<string, unknown>) => writeOnce<T>(crmWriteWebhook(), method, params);
export const writeTask = <T>(method: string, params: Record<string, unknown>) => writeOnce<T>(taskWebhook(), method, params);

/** Временный сбой (лимит, таймаут, сеть, 5xx) — строку повторить позже, а не считать ошибкой. */
export function isTransient(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /QUERY_LIMIT_EXCEEDED|OPERATION_TIME_LIMIT|BROKEN_RESPONSE|timeout|timed out|aborted|fetch failed|ECONN|ETIMEDOUT|socket|HTTP 5\d\d|после \d+ попыток/i.test(m);
}

const ru2 = (n: number) => String(n).padStart(2, '0');
/** Дата Битрикса (ISO с поясом) → дд.мм.гггг по Москве. */
export function fmtDate(v: unknown): string | null {
  if (!v || typeof v !== 'string') return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 3 * 3600_000);
  return `${ru2(d.getUTCDate())}.${ru2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}
const money = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
export function fmtMoney(v: unknown, currency?: unknown): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${money.format(n)} ${!currency || currency === 'RUB' ? '₽' : String(currency)}`;
}

export const dealUrl = (id: number) => `${PORTAL}/crm/deal/details/${id}/`;
export const leadUrl = (id: number) => `${PORTAL}/crm/lead/details/${id}/`;
export const contactUrl = (id: number) => `${PORTAL}/crm/contact/details/${id}/`;
export const companyUrl = (id: number) => `${PORTAL}/crm/company/details/${id}/`;
/** Задача открывается по пути любого пользователя — берём исполнителя. */
export const taskUrl = (id: number, userId: number) => `${PORTAL}/company/personal/user/${userId || 0}/tasks/task/view/${id}/`;
/** OWNER_TYPE_ID дела: 1 лид, 2 сделка, 3 контакт, 4 компания. */
export function ownerUrl(ownerTypeId: number, ownerId: number): string | null {
  if (!ownerId) return null;
  if (ownerTypeId === 1) return leadUrl(ownerId);
  if (ownerTypeId === 2) return dealUrl(ownerId);
  if (ownerTypeId === 3) return contactUrl(ownerId);
  if (ownerTypeId === 4) return companyUrl(ownerId);
  return null;
}
