// S2 — вход по роботу Битрикса. Робот «Исходящий вебхук» на стадиях «Сделал запрос снабженцу…» /
// «Есть цена дешевле…» (4 воронки) бьёт в POST /api/logist-requests/trigger?key=<секрет>&deal={{ID}}.
// Тип — по ТЕКУЩЕЙ стадии сделки (crm.deal.get), не по параметру: параметр `type` — только подсказка,
// если сделка успела уехать со стадии, пока шёл вебхук. Повтор стадии при открытом запросе того же типа
// ничего не создаёт (createDraft source='robot' → created=false).
//
// Режим (logist_request_settings.robotMode): send — сразу в «Новые» (как бизнес-процесс сейчас),
// не прошли проверки отправки (cheaper без цены конкурента, сделка без товаров, нет очереди) — черновик;
// draft — всегда черновик. Менеджеру — бот «Аналитик» (функция logist_requests) со ссылкой «дополнить».
import { timingSafeEqual } from 'crypto';
import { loadNames, personOf } from '@/features/big-deals-kanban/engine/enrich';
import { sendManagerBotMessage } from '@/features/badges/engine/notifications';
import { DEFAULT_PORTAL_DOMAIN, pickAuth, tokenHint } from '@/lib/bitrix/eventsAuth';
import { REQUEST_TYPE_LABEL, TRIGGER_STAGES, type RequestType, type TriggerResponse } from './contract';
import type { LogistActor } from './actor';
import { managerRegion, readDeal } from './dealSource';
import { LogistError, createDraft, loadSettings } from './repo';

// ── аутентификация (fail-closed, по образцу lib/bitrix/eventsAuth.ts) ───────────────────

export type TriggerAuth = { ok: true } | { ok: false; reason: 'not_configured' | 'key_mismatch' | 'domain'; hint: string };

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Секрет — в URL (`?key=`), т.к. исходящему вебхуку робота заголовок не задать. LOGIST_TRIGGER_SECRET не задан —
 *  отказ всем. Если в теле пришёл auth[domain] (робот его шлёт), он обязан совпасть с порталом. */
export function authenticateTrigger(key: string | null, body: Record<string, unknown>, env: Record<string, string | undefined> = process.env): TriggerAuth {
  const expected = env.LOGIST_TRIGGER_SECRET || '';
  const got = key ?? '';
  if (!expected) return { ok: false, reason: 'not_configured', hint: tokenHint(got) };
  if (!got || !safeEqual(got, expected)) return { ok: false, reason: 'key_mismatch', hint: tokenHint(got) };
  const { domain } = pickAuth(body);
  if (domain && domain !== (env.BITRIX_PORTAL_DOMAIN || DEFAULT_PORTAL_DOMAIN).toLowerCase()) return { ok: false, reason: 'domain', hint: tokenHint(got) };
  return { ok: true };
}

// ── разбор запроса робота ───────────────────────────────────────────────────────────────

/** id сделки: `?deal=` / `?id=` (подстановка {{ID}} в URL робота) или document_id робота
 *  (`document_id[2]=DEAL_123` в form-data, `document_id: [.., .., 'DEAL_123']` в JSON). */
export function pickDealId(query: URLSearchParams, body: Record<string, unknown>): number | null {
  const cands: unknown[] = [query.get('deal'), query.get('id'), query.get('deal_id'), body.deal, body.deal_id, body.id, body['document_id[2]']];
  if (Array.isArray(body.document_id)) cands.push(body.document_id[2]);
  for (const c of cands) {
    if (c == null || c === '') continue;
    const m = /^(?:DEAL_)?(\d{1,12})$/.exec(String(c).trim());
    if (m) return Number(m[1]);
  }
  return null;
}

export function typeByStage(stageId: string | null | undefined): RequestType | null {
  if (!stageId) return null;
  for (const t of Object.keys(TRIGGER_STAGES) as RequestType[]) if (TRIGGER_STAGES[t].includes(stageId)) return t;
  return null;
}

export function parseTypeHint(v: string | null): RequestType | null {
  return v === 'supply' || v === 'cheaper' ? v : null;
}

/** Робот действует не от сессии: системный актёр (журнал — без автора, видимость — всё). */
function robotActor(): LogistActor {
  const info = { bitrixId: null, name: 'Робот Битрикса', canManage: true, isLogist: false, isRop: false, queueIds: [] };
  return { bitrixId: null, login: 'bitrix-robot', canManage: true, queueIds: new Set(), leadQueueIds: new Set(), zone: 'all', name: info.name, info };
}

const ORIGIN = () => (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.ru').replace(/\/$/, '');

/** Ссылка на форму «дополнить запрос» (страница app/(app)/logist-requests/[id]). */
export const requestFormUrl = (id: number) => `${ORIGIN()}/logist-requests/${id}`;

// ── основной путь ───────────────────────────────────────────────────────────────────────

export async function runTrigger(dealId: number, typeHint: RequestType | null): Promise<TriggerResponse> {
  const deal = await readDeal(dealId);
  const type = typeByStage(deal.stageId) ?? typeHint;
  if (!type) return { ok: true, result: 'skipped' };
  const managerId = deal.assignedBitrixId && deal.assignedBitrixId !== '0' ? String(deal.assignedBitrixId) : null;
  if (!managerId) throw new LogistError(`У сделки ${dealId} нет ответственного`, 400, 'invalid');
  await loadNames([managerId]).catch(() => undefined);
  const manager = { bitrixId: managerId, name: personOf(managerId)?.name ?? null };
  const region = await managerRegion(managerId);
  const settings = await loadSettings();
  const a = robotActor();
  const seed = {
    type, source: 'robot' as const, manager, managerRegion: region, createdByLogin: a.login,
    deal: { id: deal.dealId, title: deal.title, amount: deal.amount, categoryId: deal.categoryId, stageId: deal.stageId, clientRef: deal.clientRef, clientName: deal.clientName, address: deal.address },
    header: {}, items: deal.items, productGroups: deal.productGroups,
  };

  let draftReason: string | undefined;
  let res: Awaited<ReturnType<typeof createDraft>>;
  if (settings.robotMode === 'send') {
    try {
      res = await createDraft(a, { ...seed, sendNow: true });
    } catch (e) {
      // проверки отправки не прошли — ничего не создано; кладём черновик, чтобы менеджер дополнил
      if (!(e instanceof LogistError) || e.code !== 'invalid') throw e;
      draftReason = e.message;
      res = await createDraft(a, seed);
    }
  } else {
    draftReason = 'режим «сначала форма»';
    res = await createDraft(a, seed);
  }
  const r = res.request;
  if (!res.created) return { ok: true, result: 'exists', requestId: r.id, status: r.status, type };

  await notifyManager(Number(managerId), r.id, type, r.status === 'draft', deal.title, draftReason);
  return { ok: true, result: 'created', requestId: r.id, status: r.status, type, ...(r.status === 'draft' && draftReason ? { draftReason } : {}) };
}

async function notifyManager(managerId: number, id: number, type: RequestType, isDraft: boolean, dealTitle: string | null, reason?: string): Promise<void> {
  const link = `[URL=${requestFormUrl(id)}]${isDraft ? 'Заполнить и отправить' : 'Дополнить запрос'}[/URL]`;
  const what = `«${REQUEST_TYPE_LABEL[type]}» по сделке${dealTitle ? ` «${dealTitle}»` : ''}`;
  const text = isDraft
    ? `[B]Запрос логисту №${id} ждёт тебя[/B]\n${what}: черновик с товарами сделки готов, но логистам ещё не ушёл${reason && reason !== 'режим «сначала форма»' ? ` (${reason})` : ''}.\n${link}`
    : `[B]Запрос логисту №${id} отправлен[/B]\n${what} — уже в очереди у логистов, с товарами сделки. Если нужно — добавь позиции, которых нет в 1С, адрес, дату поставки или комментарий.\n${link}`;
  await sendManagerBotMessage(managerId, text, 'logist_request', `logist_request:${id}`);
}
