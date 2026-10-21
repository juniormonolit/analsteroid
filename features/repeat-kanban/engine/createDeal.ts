// Кнопка «Задача» канбана повторных продаж — по ТЗ старого канбана Битрикса
// (/crm/mltclients/, проект «Повторные продажи», группа 118; ТЗ владельца 20.10, логика
// ОДИНАКОВАЯ со старым канбаном — он остаётся жить параллельно).
//
// Смотрим ПОСЛЕДНЮЮ ПОВТОРНУЮ сделку заказчика (воронки 2/3):
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
import { CLIENT_KEY_CASE_SQL } from '@/features/customers/engine/clientKey';
import { NEW_DEAL_STAGE, REPEAT_PROJECT_GROUP_ID } from './config';

export class DealCreateError extends Error {}

const PREFIX = 'ПОСМОТРИ ЗАДАЧУ';
const DO_NOT_TOUCH_STAGES = new Set(['C2:2']);
const SOLD_STAGES = new Set(['C2:FINAL_INVOICE', 'C3:1']);
const DEADLINE_DAYS = 5;

/** Анкета последней отгруженной сделки — порядок и подписи как в шаблоне ТЗ. */
const QUESTIONS: { field: string; label: string }[] = [
  { field: 'UF_CRM_1789046051', label: 'Для каких целей / Что строит?' },
  { field: 'UF_CRM_1765277142894', label: 'Материал приобретался на этап:' },
  { field: 'UF_CRM_1765277177195', label: 'Следующий этап строительства:' },
  { field: 'UF_CRM_1765277542864', label: 'Следующим будет закупать:' },
  { field: 'UF_CRM_1765277651257', label: 'Строитель или прораб:' },
];

function crmWebhook(): string {
  // Запись сделок — вебхук BITRIX_WEBHOOK_URL_2 (scope crm на запись, как у «Разгрузки»).
  const w = process.env.BITRIX_WEBHOOK_URL_2 || process.env.BITRIX_WEBHOOK_URL || '';
  if (!w) throw new DealCreateError('Не задан вебхук Битрикса');
  return w.replace(/\/+$/, '');
}
function taskWebhook(): string {
  // Задачи — основной вебхук: у него scope task/tasks (у _2 только crm).
  const w = process.env.BITRIX_WEBHOOK_URL || '';
  if (!w) throw new DealCreateError('Не задан BITRIX_WEBHOOK_URL');
  return w.replace(/\/+$/, '');
}

async function read<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const body = await bx(taskWebhook(), method, params) as { result: T };
  return body.result;
}

/** Запись без автоповтора: повтор после таймаута мог бы задвоить сделку/задачу. */
async function writeOnce<T>(base: string, method: string, params: Record<string, unknown>): Promise<T> {
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

/** Текст задачи по шаблону ТЗ (BB-код Битрикса, как у живых задач проекта 118). */
async function buildDescription(clientKey: string, comment: string): Promise<string> {
  const shipped = await analyticsDb().query<{ deal_id: number; head_group_name: string | null; deal_name: string | null; amount: string | null }>(
    `SELECT deal_id, head_group_name, deal_name, amount FROM (
       SELECT d.*, (${CLIENT_KEY_CASE_SQL}) AS client_key FROM sa.deals d
        WHERE d.funnel_id IN (0,1,2,3) AND d.delivered_at IS NOT NULL
     ) t WHERE client_key = $1 ORDER BY delivered_at DESC, deal_id DESC LIMIT 30`,
    [clientKey],
  );
  const lines: string[] = ['[B]Отгружали этому заказчику:[/B]'];
  for (const r of shipped.rows) {
    const label = r.head_group_name || r.deal_name || `Сделка #${r.deal_id}`;
    lines.push(`-  [url=/crm/deal/details/${r.deal_id}/]${label}[/url] - ${rubFmt.format(Math.round(Number(r.amount ?? 0)))} руб`);
  }
  if (!shipped.rows.length) lines.push('—');
  if (comment.trim()) lines.push('', comment.trim());

  const last = shipped.rows[0];
  if (last) {
    try {
      const [deal, enums] = await Promise.all([read<BxDeal>('crm.deal.get', { id: last.deal_id }), dealEnumTexts()]);
      const answers: string[] = [];
      for (const q of QUESTIONS) {
        const raw = deal?.[q.field];
        const vals = (Array.isArray(raw) ? raw : [raw]).filter(v => v !== null && v !== undefined && v !== '' && v !== false);
        const text = vals.map(v => enums[q.field]?.[String(v)] ?? String(v)).join(', ').trim();
        if (text) answers.push(`${q.label} ${text}`);
      }
      if (answers.length) lines.push('', '[B]По последней успешной сделке:[/B]', ...answers);
    } catch (e) {
      console.warn('[repeat-kanban] анкета последней отгрузки не прочиталась:', e instanceof Error ? e.message : e);
    }
  }
  return lines.join('\n');
}

/** Срок по умолчанию: +5 дней, 19:00 МСК — как у задач старого канбана (если РОП не выбрал
 *  дату; канбан предлагает «до конца окна», владелец 21.10). */
function deadlineIso(now = Date.now()): string {
  const msk = new Date(now + 3 * 3600_000 + DEADLINE_DAYS * 86_400_000);
  return `${msk.toISOString().slice(0, 10)}T19:00:00+03:00`;
}

export type RepeatDealMode = 'existing' | 'reopened' | 'created';

export interface RepeatTaskResult { dealId: number; dealMode: RepeatDealMode; taskId: number; responsibleId: string; createdById: string; chatPosted: boolean }

export async function createRepeatTask(input: {
  clientKey: string; fallbackManagerId: string; creatorBitrixId: string; comment: string;
  /** Кто написал комментарий (нажавший, его Битрикс-id) — автор сообщения в чате задачи. */
  commentAuthorId: string | null;
  /** Срок задачи (YYYY-MM-DD) и время (HH:MM, МСК; не задано — 19:00); дата не задана — +5 дней. */
  deadlineDate?: string | null;
  deadlineTime?: string | null;
}): Promise<RepeatTaskResult> {
  const t = dealTargetOf(input.clientKey);
  if (!Number.isInteger(t.id) || t.id <= 0) throw new DealCreateError('Некорректный заказчик');
  const owner = t.entity === 'contact' ? 'CONTACT_ID' : 'COMPANY_ID';
  const crm = crmWebhook();

  const last = (await read<BxDeal[]>('crm.deal.list', {
    filter: { [owner]: t.id, '@CATEGORY_ID': [2, 3] },
    select: ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'ASSIGNED_BY_ID'], order: { ID: 'DESC' },
  }))?.[0];

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

  const description = await buildDescription(input.clientKey, input.comment);
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
    },
  });
  const taskId = Number(task?.task?.id ?? 0);
  if (!taskId) throw new DealCreateError(`Сделка #${dealId} подготовлена, но задача в Битриксе не создалась`);
  // Комментарий РОПа — ещё и первым сообщением в чате задачи (владелец 20.10). Не роняет
  // постановку: задача уже есть, комментарий в любом случае лежит в её описании.
  let chatPosted = false;
  if (input.comment.trim()) {
    chatPosted = await postToTaskChat(taskId, input.commentAuthorId ?? input.creatorBitrixId, input.comment.trim()).catch(e => {
      console.warn(`[repeat-kanban] комментарий в чат задачи ${taskId} не ушёл:`, e instanceof Error ? e.message : e);
      return false;
    });
  }
  return { dealId, dealMode, taskId, responsibleId, createdById: input.creatorBitrixId, chatPosted };
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
async function postToTaskChat(taskId: number, authorId: string, comment: string): Promise<boolean> {
  const res = await bx(taskWebhook(), 'task.commentitem.add', {
    TASKID: taskId, FIELDS: { AUTHOR_ID: Number(authorId), POST_MESSAGE: comment },
  }) as { result?: number };
  return Number(res?.result) > 0;
}
