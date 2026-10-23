// Кнопка «Задача» канбана повторных продаж — по ТЗ старого канбана Битрикса
// (/crm/mltclients/, проект «Повторные продажи», группа 118; ТЗ владельца 20.10, логика
// ОДИНАКОВАЯ со старым канбаном — он остаётся жить параллельно).
//
// Сначала ищем ОТКРЫТУЮ повторную сделку заказчика (воронки 2/3) — среди всех, не только
// последней (21.10, живой случай 272639: открытая 215670 «Бронь» с 30.06 была старше
// отгруженной 267699 — канбан создал вторую сделку). Для компании — и сделки её контактов
// (контакты, встречавшиеся в сделках компании: свежие сделки часто заведены на контакт без
// компании, случай компании 20460). Открытой нет — смотрим ПОСЛЕДНЮЮ:
//   * в отказе            → возвращаем в первую стадию её воронки + «ПОСМОТРИ ЗАДАЧУ» в начало названия;
//   * отгружена / нет её  → новая сделка + «ПОСМОТРИ ЗАДАЧУ» в начале названия;
//   * в работе            → задача в эту сделку + «ПОСМОТРИ ЗАДАЧУ» в начало названия;
//   * «Продано»           → задачу не ставим: заказ в работе, ждём отгрузки (решение 20.10);
//   * «НЕ ТРОГАТЬ»        → не трогаем.
// «ПОСМОТРИ ЗАДАЧУ» ставится один раз (не «ПОСМОТРИ ЗАДАЧУ ПОСМОТРИ ЗАДАЧУ»).
//
// Новая сделка — НЕ копией прошлой, как делает старый канбан («… (1)»): копия тащит
// старые отметки времени (BACKLOG 20.10). Создаём так, как менеджер создаёт из контакта
// (разбор 100 сделок 20.10: ответственный, источник, компания, реквизиты нашей компании),
// а название — «ПОСМОТРИ ЗАДАЧУ» + название прошлой сделки, как у старого канбана.
//
// Задача (как у живых задач проекта 118): группа 118, исполнитель — ответственный сделки,
// постановщик — руководитель менеджера, контроль постановщика (менеджер переводит только в
// «ждёт контроля»), срок +5 дней 19:00 без права переноса, привязка к сделке, текст по
// шаблону: отгрузки со ссылками и суммами, комментарий РОПа, анкета последней отгрузки.
import { bx } from '@/lib/bitrix/notify';
import { cached } from '@/lib/cache/redis';
import { analyticsDb } from '@/lib/db/clients';
import { CLIENT_KEY_SQL } from '@/features/customers/engine/clientKey';
import { memberKeysOf } from '@/features/customers/engine/merge';
import { NEW_DEAL_STAGE, REPEAT_PROJECT_GROUP_ID } from './config';
import { logRecommendations } from './recommendations';
import { ROP_TOKEN, type TaskParticipants } from './participants';
import { freshMemoForClientKey, markMemoInserted } from '@/features/ai-analysis/engine/memoStore';
import { blockBb, memoLinesBb, splitComment } from '@/features/ai-analysis/engine/memo';

export class DealCreateError extends Error {}

const PREFIX = 'ПОСМОТРИ ЗАДАЧУ';
const DO_NOT_TOUCH_STAGES = new Set(['C2:2']);
const SOLD_STAGES = new Set(['C2:FINAL_INVOICE', 'C3:1']);
const DEADLINE_DAYS = 5;

/** Анкета последней отгруженной сделки — порядок и подписи как в шаблоне ТЗ. */
const QUESTIONS: { field: string; label: string; short: string }[] = [
  { field: 'UF_CRM_1789046051', label: 'Для каких целей / Что строит?', short: 'строит' },
  { field: 'UF_CRM_1765277142894', label: 'Материал приобретался на этап:', short: 'этап' },
  { field: 'UF_CRM_1765277177195', label: 'Следующий этап строительства:', short: 'следующий этап' },
  { field: 'UF_CRM_1765277542864', label: 'Следующим будет закупать:', short: 'дальше закупает' },
  { field: 'UF_CRM_1765277651257', label: 'Строитель или прораб:', short: 'кто' },
];

function crmWebhook(): string {
  // Запись сделок — вебхук BITRIX_WEBHOOK_URL_2 (scope crm на запись, как у «Разгрузки»).
  const w = process.env.BITRIX_WEBHOOK_URL_2 || process.env.BITRIX_WEBHOOK_URL || '';
  if (!w) throw new DealCreateError('Не задан вебхук Битрикса');
  return w.replace(/\/+$/, '');
}
export function taskWebhook(): string {
  // Задачи — основной вебхук: у него scope task/tasks (у _2 только crm).
  const w = process.env.BITRIX_WEBHOOK_URL || '';
  if (!w) throw new DealCreateError('Не задан BITRIX_WEBHOOK_URL');
  return w.replace(/\/+$/, '');
}

export async function read<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const body = await bx(taskWebhook(), method, params) as { result: T };
  return body.result;
}

/** Запись без автоповтора: повтор после таймаута мог бы задвоить сделку/задачу. */
export async function writeOnce<T>(base: string, method: string, params: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}/${method}.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new DealCreateError(`Битрикс ${method}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = await res.json().catch(() => null) as { result?: T; error?: string; error_description?: string } | null;
  if (!res.ok || !body || body.error || body.result === undefined || body.result === null || (body.result as unknown) === false) {
    throw new DealCreateError(`Битрикс ${method}: ${body?.error ?? `HTTP ${res.status}`} ${body?.error_description ?? ''}`.trim());
  }
  return body.result;
}

interface BxEntity { ID: string; ASSIGNED_BY_ID?: string; SOURCE_ID?: string | null; SOURCE_DESCRIPTION?: string | null; COMPANY_ID?: string | null }
interface BxDeal {
  ID: string; TITLE?: string; CATEGORY_ID?: string; STAGE_ID?: string; STAGE_SEMANTIC_ID?: string;
  ASSIGNED_BY_ID?: string; MYCOMPANY_ID?: string | null; [k: string]: unknown;
}

/** Ключ заказчика → сущность. 'c' — физлицо (B2C, воронка 2); 'k' — компания и
 *  'x' (юр-сделка без карточки компании, физически контакт) — B2B, воронка 3. */
export function dealTargetOf(clientKey: string): { funnel: 2 | 3; entity: 'contact' | 'company'; id: number } {
  const id = Number(clientKey.slice(1));
  if (clientKey.startsWith('k')) return { funnel: 3, entity: 'company', id };
  return { funnel: clientKey.startsWith('x') ? 3 : 2, entity: 'contact', id };
}

const withPrefix = (title: string) => {
  const t = title.trim();
  return t.toUpperCase().includes(PREFIX) ? t : `${PREFIX} ${t}`.trim();
};

/** Тексты вариантов списочных полей сделки (анкета хранит id варианта). */
async function dealEnumTexts(): Promise<Record<string, Record<string, string>>> {
  return cached('repeat-kanban:deal-enums:v1', 24 * 3600, async () => {
    const fields = await read<Record<string, { type?: string; items?: { ID: string; VALUE: string }[] }>>('crm.deal.fields', {});
    const out: Record<string, Record<string, string>> = {};
    for (const q of QUESTIONS) {
      const f = fields?.[q.field];
      if (f?.items?.length) out[q.field] = Object.fromEntries(f.items.map(i => [String(i.ID), i.VALUE]));
    }
    return out;
  });
}

const rubFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

/** Отгрузок в описании задачи: больше — скролл на телефоне до сути; остальное — итоговой строкой. */
const SHIPPED_IN_TASK = 5;
const ddmmyyyy = (d: Date) => new Date(new Date(d).getTime() + 3 * 3600_000).toISOString().slice(0, 10).split('-').reverse().join('.');

/**
 * Текст задачи (BB-код Битрикса). Владелец 23.10 («делай всё целиком»), по разбору Fable:
 * сначала то, что нужно для звонка, потом контекст —
 *   памятка ИИ (если есть свежий анализ) → «От РОПа» (серой цитатой >>, отделить человека от системы)
 *   → последние 5 отгрузок с датами + итог → анкета последней сделки одной строкой.
 * BB-коды — только рабочие (проверено 23.10): [LIST]/[QUOTE]/[TABLE] Битрикс не рисует → «•» и «>>».
 * Жирный — только в памятке и заголовках блоков; суммы обычным шрифтом.
 */
export async function buildDescription(clientKey: string, comment: string, memoBb: string | null): Promise<string> {
  const members = await memberKeysOf(clientKey); // склейка: отгрузки всех карточек человека
  const shipped = await analyticsDb().query<{ deal_id: number; head_group_name: string | null; deal_name: string | null; amount: string | null; delivered_at: Date; n: number; total: string }>(
    `SELECT deal_id, head_group_name, deal_name, amount, delivered_at,
            count(*) OVER ()::int AS n, sum(amount) OVER ()::text AS total
       FROM (
       SELECT d.*, (${CLIENT_KEY_SQL}) AS client_key FROM sa.deals d
        WHERE d.funnel_id IN (0,1,2,3) AND d.delivered_at IS NOT NULL
          AND (d.contact_id = ANY($2::bigint[]) OR d.company_id = ANY($2::bigint[]))
     ) t WHERE client_key = ANY($1::text[]) ORDER BY delivered_at DESC, deal_id DESC LIMIT 30`,
    [members, members.map(k => Number(k.slice(1)))],
  );
  const lines: string[] = [];
  if (memoBb) lines.push(memoBb, '');
  if (comment.trim()) lines.push('[B]От РОПа:[/B]', ...comment.trim().split('\n').map(l => `>>${l}`), '');

  const rows = shipped.rows;
  if (rows.length) {
    const n = rows[0].n;
    lines.push(`[B]Отгружали[/B]${n > SHIPPED_IN_TASK ? ` [COLOR=#999999](последние ${SHIPPED_IN_TASK} из ${n})[/COLOR]` : ''}`);
    for (const r of rows.slice(0, SHIPPED_IN_TASK)) {
      const label = r.head_group_name || r.deal_name || `Сделка #${r.deal_id}`;
      lines.push(`• ${ddmmyyyy(r.delivered_at)} — [url=/crm/deal/details/${r.deal_id}/]${label}[/url] — ${rubFmt.format(Math.round(Number(r.amount ?? 0)))} ₽`);
    }
    if (n > 1) lines.push(`[COLOR=#999999]Всего отгрузок: ${n} на ${rubFmt.format(Math.round(Number(rows[0].total ?? 0)))} ₽[/COLOR]`);
  }

  const last = rows[0];
  if (last) {
    try {
      const [deal, enums] = await Promise.all([read<BxDeal>('crm.deal.get', { id: last.deal_id }), dealEnumTexts()]);
      const answers: string[] = [];
      for (const q of QUESTIONS) {
        const raw = deal?.[q.field];
        const vals = (Array.isArray(raw) ? raw : [raw]).filter(v => v !== null && v !== undefined && v !== '' && v !== false);
        const text = vals.map(v => enums[q.field]?.[String(v)] ?? String(v)).join(', ').trim();
        if (text) answers.push(`${q.short}: ${text}`);
      }
      if (answers.length) lines.push('', `[B]Анкета по последней сделке:[/B] ${answers.join(' · ')}`);
    } catch (e) {
      console.warn('[repeat-kanban] анкета последней отгрузки не прочиталась:', e instanceof Error ? e.message : e);
    }
  }
  return lines.join('\n').trim() || '—';
}

/** Срок по умолчанию: +5 дней, 19:00 МСК — как у задач старого канбана (если РОП не выбрал
 *  дату; канбан предлагает «до конца окна», владелец 21.10). */
function deadlineIso(now = Date.now()): string {
  const msk = new Date(now + 3 * 3600_000 + DEADLINE_DAYS * 86_400_000);
  return `${msk.toISOString().slice(0, 10)}T19:00:00+03:00`;
}

export type RepeatDealMode = 'existing' | 'reopened' | 'created';

export interface RepeatTaskResult {
  dealId: number; dealMode: RepeatDealMode; taskId: number; responsibleId: string; createdById: string; chatPosted: boolean;
  /** Запущен бизнес-процесс «Сменить ответственного» (id процесса). */
  reassignWorkflowId?: string | null;
  /** Кого добавили соисполнителями и наблюдателями (Битрикс-id, после разворота «РОП менеджера»). */
  accomplices?: number[]; auditors?: number[];
}

/** Шаблон бизнес-процесса Битрикса «Сменить ответственного» (сделка). Менять ответственного —
 *  ТОЛЬКО им (владелец 21.10): он перепривязывает сделку, контакт, почту и т.д. Параметр шаблона —
 *  new_responsible_id (тип «пользователь», значение user_<id>). */
export const REASSIGN_TEMPLATE_ID = 171;

/** Контакты, встречавшиеся в сделках компании (обе стороны заполнены) — по копии sa. */
export async function companyContacts(companyId: number): Promise<number[]> {
  const r = await analyticsDb().query<{ contact_id: string }>(
    `SELECT DISTINCT contact_id::text AS contact_id FROM sa.deals
      WHERE company_id = $1 AND coalesce(contact_id, 0) <> 0 AND funnel_id IN (0, 1, 2, 3) LIMIT 20`, [companyId],
  ).catch(() => ({ rows: [] as { contact_id: string }[] }));
  return r.rows.map(x => Number(x.contact_id)).filter(n => n > 0);
}

async function startReassign(dealId: number, newResponsibleId: string): Promise<string> {
  const res = await writeOnce<string>(taskWebhook(), 'bizproc.workflow.start', {
    TEMPLATE_ID: REASSIGN_TEMPLATE_ID,
    DOCUMENT_ID: ['crm', 'CCrmDocumentDeal', `DEAL_${dealId}`],
    PARAMETERS: { new_responsible_id: `user_${newResponsibleId}` },
  });
  return String(res);
}

export async function createRepeatTask(input: {
  clientKey: string; fallbackManagerId: string; creatorBitrixId: string; comment: string;
  /** Кто написал комментарий (нажавший, его Битрикс-id) — автор сообщения в чате задачи. */
  commentAuthorId: string | null;
  /** Срок задачи (YYYY-MM-DD) и время (HH:MM, МСК; не задано — 19:00); дата не задана — +5 дней. */
  deadlineDate?: string | null;
  deadlineTime?: string | null;
  /** «И сменить менеджера на …»: Битрикс-id нового ответственного (БП 171), задача — ему. */
  newResponsibleId?: string | null;
  /** Соисполнители и наблюдатели задачи (ROP_TOKEN — РОП ответственного менеджера). */
  participants?: TaskParticipants | null;
}): Promise<RepeatTaskResult> {
  const t = dealTargetOf(input.clientKey);
  if (!Number.isInteger(t.id) || t.id <= 0) throw new DealCreateError('Некорректный заказчик');
  // Склейка (merge.ts): у человека с юр-сделками (x) новая сделка — в юр-воронку; открытую ищем по всем его контактам.
  const members = await memberKeysOf(input.clientKey);
  if (t.entity === 'contact' && members.some(k => k.startsWith('x'))) t.funnel = 3;
  const memberContacts = [...new Set(members.filter(k => !k.startsWith('k')).map(k => Number(k.slice(1))))].filter(id => !(t.entity === 'contact' && id === t.id));
  const owner = t.entity === 'contact' ? 'CONTACT_ID' : 'COMPANY_ID';
  const crm = crmWebhook();

  const select = ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'ASSIGNED_BY_ID'];
  const lists = [read<BxDeal[]>('crm.deal.list', { filter: { [owner]: t.id, '@CATEGORY_ID': [2, 3] }, select, order: { ID: 'DESC' } })];
  if (t.entity === 'company') {
    for (const c of (await companyContacts(t.id)).slice(0, 10)) {
      lists.push(read<BxDeal[]>('crm.deal.list', { filter: { CONTACT_ID: c, '@CATEGORY_ID': [2, 3] }, select, order: { ID: 'DESC' } }));
    }
  }
  for (const c of memberContacts.slice(0, 10)) {
    lists.push(read<BxDeal[]>('crm.deal.list', { filter: { CONTACT_ID: c, '@CATEGORY_ID': [2, 3] }, select, order: { ID: 'DESC' } }));
  }
  const seen = new Set<string>();
  const all = (await Promise.all(lists)).flat().filter(d => d && !seen.has(d.ID) && seen.add(d.ID))
    .sort((a, b) => Number(b.ID) - Number(a.ID));
  // Открытая (в работе, в т.ч. «Продано») важнее последней по номеру.
  const open = all.find(d => d.STAGE_SEMANTIC_ID === 'P');
  const last = open ?? all[0];

  if (last?.STAGE_ID && DO_NOT_TOUCH_STAGES.has(last.STAGE_ID)) {
    throw new DealCreateError(`Сделка #${last.ID} в стадии «НЕ ТРОГАТЬ — ЗАПРЕЩЕНО»: заказчика не трогаем`);
  }
  if (last?.STAGE_ID && SOLD_STAGES.has(last.STAGE_ID)) {
    throw new DealCreateError(`Сделка #${last.ID} продана и ждёт отгрузки — задачу поставим после отгрузки`);
  }

  let dealId: number;
  let dealMode: RepeatDealMode;
  let title: string;
  let responsibleId: string;

  if (last && (last.STAGE_SEMANTIC_ID === 'F' || last.STAGE_SEMANTIC_ID === 'P')) {
    dealId = Number(last.ID);
    title = withPrefix(last.TITLE ?? `Сделка #${last.ID}`);
    responsibleId = String(last.ASSIGNED_BY_ID ?? input.fallbackManagerId);
    const fields: Record<string, unknown> = { TITLE: title };
    if (last.STAGE_SEMANTIC_ID === 'F') {
      const cat = Number(last.CATEGORY_ID) === 3 ? 3 : 2;
      fields.STAGE_ID = NEW_DEAL_STAGE[cat];
      dealMode = 'reopened';
    } else {
      dealMode = 'existing';
    }
    await writeOnce(crm, 'crm.deal.update', { id: dealId, fields, params: { REGISTER_SONET_EVENT: 'Y' } });
  } else {
    // Отгружена последняя повторная или повторных не было — новая сделка «как из контакта».
    const entity = await read<BxEntity>(t.entity === 'contact' ? 'crm.contact.get' : 'crm.company.get', { id: t.id });
    if (!entity?.ID) throw new DealCreateError(`${t.entity === 'contact' ? 'Контакт' : 'Компания'} #${t.id} не найден(а) в Битриксе`);
    const prev = await read<BxDeal[]>('crm.deal.list', { filter: { [owner]: t.id }, select: ['ID', 'MYCOMPANY_ID'], order: { ID: 'DESC' } });
    const funnel: 2 | 3 = last ? (Number(last.CATEGORY_ID) === 3 ? 3 : 2) : t.funnel;
    responsibleId = String(entity.ASSIGNED_BY_ID ?? input.fallbackManagerId);
    title = last?.TITLE ? withPrefix(last.TITLE.replace(/(\s*\(\d+\))+\s*$/, '')) : PREFIX;
    const fields: Record<string, unknown> = {
      TITLE: title, CATEGORY_ID: funnel, STAGE_ID: NEW_DEAL_STAGE[funnel], [owner]: t.id,
      ASSIGNED_BY_ID: Number(responsibleId), OPENED: 'Y', TYPE_ID: 'SALE', CURRENCY_ID: 'RUB',
    };
    if (entity.SOURCE_ID) fields.SOURCE_ID = entity.SOURCE_ID;
    if (entity.SOURCE_DESCRIPTION) fields.SOURCE_DESCRIPTION = entity.SOURCE_DESCRIPTION;
    if (t.entity === 'contact' && entity.COMPANY_ID && Number(entity.COMPANY_ID) > 0) fields.COMPANY_ID = Number(entity.COMPANY_ID);
    const myCompany = prev?.find(d => d.MYCOMPANY_ID && Number(d.MYCOMPANY_ID) > 0)?.MYCOMPANY_ID;
    if (myCompany) fields.MYCOMPANY_ID = Number(myCompany);
    dealId = Number(await writeOnce<number>(crm, 'crm.deal.add', { fields, params: { REGISTER_SONET_EVENT: 'Y' } }));
    dealMode = 'created';
  }

  // Смена менеджера — бизнес-процессом Битрикса (не прямой записью ASSIGNED_BY_ID), задача — новому.
  let reassignWorkflowId: string | null = null;
  if (input.newResponsibleId && /^\d{1,10}$/.test(input.newResponsibleId) && input.newResponsibleId !== responsibleId) {
    try {
      reassignWorkflowId = await startReassign(dealId, input.newResponsibleId);
    } catch (e) {
      throw new DealCreateError(`Сделка #${dealId} готова, но смена менеджера не запустилась: ${e instanceof Error ? e.message : e}. Задачу не ставили.`);
    }
    responsibleId = input.newResponsibleId;
  }

  // Памятка «Перед звонком» (владелец 23.10): приходит внутри сообщения по шаблону (settings.renderTemplate
  // дописывает её обычным текстом, РОП может править или стереть). Здесь вынимаем её из текста и оформляем
  // BB-блоком — в описании первым, в чате задачи тоже. Стёрли — памятки нет: сами не добавляем.
  const parts = splitComment(input.comment);
  // Блоки разбора в порядке владельца: «Перед звонком» → «Предложить» → «Выяснить» (дальше «От РОПа», отгрузки).
  const memoBb = [
    parts.memo ? memoLinesBb(parts.memo.date, parts.memo.lines) : null,
    blockBb('Предложить', parts.propose), blockBb('Выяснить', parts.clarify),
  ].filter(Boolean).join('\n\n') || null;
  const memo = memoBb ? await freshMemoForClientKey(input.clientKey) : null; // только чтобы отметить, что памятка ушла
  const description = await buildDescription(input.clientKey, parts.rop, memoBb);
  // Участники (владелец 23.10): «РОП менеджера» — по оргструктуре ответственного; сам ответственный — не участник.
  const resolve = async (ids: string[]) => {
    const out = new Set<string>();
    for (const x of ids) {
      const id = x === ROP_TOKEN ? await ropOfManager(String(responsibleId)).catch(() => null) : x;
      if (id && id !== String(responsibleId)) out.add(id);
    }
    return [...out].map(Number);
  };
  const accomplices = input.participants ? await resolve(input.participants.accomplices) : [];
  const auditors = input.participants ? (await resolve(input.participants.auditors)).filter(id => !accomplices.includes(id)) : [];
  const task = await writeOnce<{ task?: { id?: string | number } }>(taskWebhook(), 'tasks.task.add', {
    fields: {
      TITLE: title,
      DESCRIPTION: description,
      GROUP_ID: REPEAT_PROJECT_GROUP_ID,
      RESPONSIBLE_ID: Number(responsibleId),
      CREATED_BY: Number(input.creatorBitrixId),
      TASK_CONTROL: 'Y',
      ALLOW_CHANGE_DEADLINE: 'N',
      DEADLINE: input.deadlineDate && /^\d{4}-\d{2}-\d{2}$/.test(input.deadlineDate)
        ? `${input.deadlineDate}T${input.deadlineTime && /^\d{2}:\d{2}$/.test(input.deadlineTime) ? input.deadlineTime : '19:00'}:00+03:00` : deadlineIso(),
      UF_CRM_TASK: [`D_${dealId}`],
      ...(accomplices.length ? { ACCOMPLICES: accomplices } : {}),
      ...(auditors.length ? { AUDITORS: auditors } : {}),
    },
  });
  const taskId = Number(task?.task?.id ?? 0);
  if (!taskId) throw new DealCreateError(`Сделка #${dealId} подготовлена, но задача в Битриксе не создалась`);
  if (memo) await markMemoInserted(memo.analysisId, taskId);
  // Комментарий РОПа — ещё и первым сообщением в чате задачи (владелец 20.10). Не роняет
  // постановку: задача уже есть, комментарий в любом случае лежит в её описании.
  let chatPosted = false;
  const chatText = [memoBb, parts.rop].filter(Boolean).join('\n\n');
  if (chatText.trim()) {
    chatPosted = await postToTaskChat(taskId, input.commentAuthorId ?? input.creatorBitrixId, chatText).catch(e => {
      console.warn(`[repeat-kanban] комментарий в чат задачи ${taskId} не ушёл:`, e instanceof Error ? e.message : e);
      return false;
    });
  }
  // Журнал рекомендаций (миграция 250, самообучение): что советовали предложить и есть ли это в тексте задачи. Фоном.
  void logRecommendations({ clientKey: input.clientKey, managerId: input.fallbackManagerId, taskId, dealId, text: input.comment, createdBy: input.commentAuthorId ?? input.creatorBitrixId });
  return { dealId, dealMode, taskId, responsibleId, createdById: input.creatorBitrixId, chatPosted, reassignWorkflowId, accomplices, auditors };
}

/** Постановщик по структуре: РОП менеджера (sa.org_resolved_hierarchy, ближайший предок с
 *  UF_HEAD — тот же резолвер, что у оргсинка). */
export async function ropOfManager(managerBitrixId: string): Promise<string | null> {
  const r = await analyticsDb().query<{ rop: string | null }>(
    `SELECT rop_bitrix_user_id AS rop FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id = $1 LIMIT 1`, [managerBitrixId],
  );
  return r.rows[0]?.rop ?? null;
}

/**
 * Первое сообщение в чате задачи — КОММЕНТАРИЙ К ЗАДАЧЕ (task.commentitem.add) с автором =
 * тем, кто его написал. Проверено 20.10 на задаче 169274: в задачах с новой карточкой такой
 * комментарий сам появляется в чате задачи от имени автора. Первая версия писала ботом
 * «Аналитик» — Битрикс отказал: «Вы не можете отправлять сообщения в указанный чат» (бот не
 * участник задачи); от вебхука нельзя — автором был бы его владелец (Сергей Афанасьев).
 */
export async function postToTaskChat(taskId: number, authorId: string, comment: string): Promise<boolean> {
  const res = await bx(taskWebhook(), 'task.commentitem.add', {
    TASKID: taskId, FIELDS: { AUTHOR_ID: Number(authorId), POST_MESSAGE: comment },
  }) as { result?: number };
  return Number(res?.result) > 0;
}

// ── Брак → сделка закрывается в Битриксе (владелец 22.10: «да» на «брак сам закрывает сделку в
// отказ с той же причиной»). Причины брака = отказные стадии повторных воронок; у B2C нет «Объектов
// больше нет», у B2B — «Больше ничего не нужно»: берём ближайшую по смыслу стадию той же воронки.
const LOST_STAGE_BY_REASON: Record<2 | 3, Record<string, string>> = {
  2: { no_objects: 'C2:APOLOGY', nothing_needed: 'C2:APOLOGY', expensive: 'C2:LOSE', failed_client: 'C2:1' },
  3: { no_objects: 'C3:2', nothing_needed: 'C3:2', expensive: 'C3:LOSE', failed_client: 'C3:APOLOGY' },
};

export type CloseResult = 'closed' | 'already_closed' | 'not_repeat' | 'sold' | 'not_client';

/** Закрыть открытую повторную сделку заказчика в отказную стадию по причине брака + комментарий
 *  РОПа в ленту сделки. Сделка проверяется по Битриксу: повторная воронка, открыта, не «Продано»,
 *  клиент — этот заказчик (контакт, компания или контакт этой компании). */
export async function closeDealAsLost(input: { dealId: number; clientKey: string; reason: string; comment: string | null; authorId: string | null }): Promise<CloseResult> {
  const deal = await read<BxDeal & { CONTACT_ID?: string | null; COMPANY_ID?: string | null }>('crm.deal.get', { id: input.dealId });
  const cat = Number(deal?.CATEGORY_ID);
  if (cat !== 2 && cat !== 3) return 'not_repeat';
  if (deal.STAGE_SEMANTIC_ID !== 'P') return 'already_closed';
  if (deal.STAGE_ID && SOLD_STAGES.has(deal.STAGE_ID)) return 'sold';
  const contactId = Number(deal.CONTACT_ID) || 0, companyId = Number(deal.COMPANY_ID) || 0;
  let mine = false;
  for (const k of await memberKeysOf(input.clientKey)) { // склейка: сделка любой карточки человека
    const id = Number(k.slice(1));
    if (k.startsWith('k') ? companyId === id || (contactId > 0 && (await companyContacts(id)).includes(contactId)) : contactId === id) { mine = true; break; }
  }
  if (!mine) return 'not_client';
  const stage = LOST_STAGE_BY_REASON[cat][input.reason] ?? (cat === 2 ? 'C2:APOLOGY' : 'C3:2');
  await writeOnce(crmWebhook(), 'crm.deal.update', { id: input.dealId, fields: { STAGE_ID: stage }, params: { REGISTER_SONET_EVENT: 'Y' } });
  const text = `Брак из канбана повторных (Монолитика)${input.comment?.trim() ? `: ${input.comment.trim()}` : ''}`;
  await writeOnce(crmWebhook(), 'crm.timeline.comment.add', {
    fields: { ENTITY_ID: input.dealId, ENTITY_TYPE: 'deal', COMMENT: text, ...(input.authorId ? { AUTHOR_ID: Number(input.authorId) } : {}) },
  }).catch(e => console.warn('[repeat-kanban] комментарий к сделке при браке:', e instanceof Error ? e.message : e));
  return 'closed';
}
