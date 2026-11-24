// Сбор всего, что висит на аккаунте сотрудника, — ЖИВЫМ чтением из Битрикса. Копии sa.* не годятся:
// у проданных сделок ответственный заморожен триггером (seller-freeze), задачи и дела отстают.
// Только чтение, постранично (start/next), пауза ~500 мс между страницами.
import { cached } from '@/lib/cache/redis';
import type { DismissalKind } from '../types';
import { companyUrl, contactUrl, dealUrl, fmtDate, fmtMoney, leadUrl, ownerUrl, readAll, sleep, taskUrl } from './bx';

export interface ScannedItem {
  key: string;
  kind: DismissalKind;
  ord: number;
  entityId: number;
  title: string;
  url: string | null;
  subtitle: string | null;
  meta: Record<string, unknown>;
}

const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ') || null;
const num = (v: unknown) => Number(v) || 0;

/** Названия стадий сделок и статусов лидов (crm.status.list, сутки в кэше). */
async function statusNames(): Promise<Record<string, string>> {
  return cached('dismissal:crm-statuses:v1', 24 * 3600, async () => {
    const rows = await readAll<{ ENTITY_ID: string; STATUS_ID: string; NAME: string }>('crm.status.list', { order: { SORT: 'ASC' } }, { pauseMs: 300 });
    const out: Record<string, string> = {};
    for (const r of rows) {
      if (r.ENTITY_ID === 'STATUS') out[`L:${r.STATUS_ID}`] = r.NAME;
      else if (r.ENTITY_ID?.startsWith('DEAL_STAGE')) out[`D:${r.STATUS_ID}`] = r.NAME;
    }
    return out;
  }).catch(() => ({}));
}

const TASK_STATUS: Record<number, string> = { 1: 'новая', 2: 'ждёт выполнения', 3: 'выполняется', 4: 'ждёт контроля', 6: 'отложена' };
const ACTIVITY_TYPE: Record<number, string> = { 1: 'Встреча', 2: 'Звонок', 4: 'Письмо', 6: 'Дело' };
const OWNER_LABEL: Record<number, string> = { 1: 'лид', 2: 'сделка', 3: 'контакт', 4: 'компания' };

interface BxTask {
  id: string; title?: string; status?: string; deadline?: string | null; responsibleId?: string; createdBy?: string;
  accomplices?: string[]; auditors?: string[]; groupId?: string;
}
const taskList = (filter: Record<string, unknown>, onPage?: () => Promise<void> | void) => readAll<BxTask>('tasks.task.list', {
  filter: { ...filter, '!STATUS': 5 },
  select: ['ID', 'TITLE', 'STATUS', 'DEADLINE', 'RESPONSIBLE_ID', 'CREATED_BY', 'ACCOMPLICES', 'AUDITORS', 'GROUP_ID'],
  order: { ID: 'asc' },
}, { pick: r => ((r as { tasks?: BxTask[] })?.tasks ?? []), onPage });

/**
 * Полный сбор по аккаунту. onProgress — после каждой страницы (воркер отмечает heartbeat).
 * Порядок строк внутри вида — по id сущности (стабилен между пересборками).
 */
export async function scanAccount(sourceId: number, onProgress?: (stage: string) => Promise<void> | void): Promise<ScannedItem[]> {
  const items: ScannedItem[] = [];
  const ordOf: Partial<Record<DismissalKind, number>> = {};
  const push = (it: Omit<ScannedItem, 'key' | 'ord'>) => {
    const ord = (ordOf[it.kind] = (ordOf[it.kind] ?? 0) + 1);
    items.push({ ...it, key: `${it.kind}:${it.entityId}`, ord });
  };
  const tick = (stage: string) => () => onProgress?.(stage);
  const names = await statusNames();

  // ── Сделки (все воронки): открытые P, закрытые S/F ─────────────────────────
  const deals = await readAll<Record<string, string | null>>('crm.deal.list', {
    filter: { ASSIGNED_BY_ID: sourceId },
    select: ['ID', 'TITLE', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'CLOSED', 'OPPORTUNITY', 'CURRENCY_ID', 'CATEGORY_ID', 'DATE_CREATE', 'CLOSEDATE', 'CONTACT_ID', 'COMPANY_ID'],
    order: { ID: 'ASC' },
  }, { onPage: tick('deals') });
  for (const d of deals) {
    const id = num(d.ID);
    if (!id) continue;
    const sem = d.STAGE_SEMANTIC_ID ?? (d.CLOSED === 'Y' ? 'S' : 'P');
    const open = sem === 'P' && d.CLOSED !== 'Y';
    const stage = names[`D:${d.STAGE_ID}`] ?? d.STAGE_ID ?? null;
    push({
      kind: open ? 'deal_open' : 'deal_closed', entityId: id, title: d.TITLE?.trim() || `Сделка #${id}`, url: dealUrl(id),
      subtitle: join(stage, fmtMoney(d.OPPORTUNITY, d.CURRENCY_ID), open ? `создана ${fmtDate(d.DATE_CREATE) ?? '—'}` : (fmtDate(d.CLOSEDATE) && `закрыта ${fmtDate(d.CLOSEDATE)}`), !open && (sem === 'S' ? 'выиграна' : 'проиграна')),
      meta: { stageId: d.STAGE_ID, semantic: sem, categoryId: num(d.CATEGORY_ID), contactId: num(d.CONTACT_ID) || null, companyId: num(d.COMPANY_ID) || null },
    });
  }
  await sleep(500);

  // ── Лиды: только в работе ─────────────────────────────────────────────────
  const leads = await readAll<Record<string, string | null>>('crm.lead.list', {
    filter: { ASSIGNED_BY_ID: sourceId, STATUS_SEMANTIC_ID: 'P' },
    select: ['ID', 'TITLE', 'NAME', 'LAST_NAME', 'STATUS_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'DATE_CREATE'],
    order: { ID: 'ASC' },
  }, { onPage: tick('leads') });
  for (const l of leads) {
    const id = num(l.ID);
    if (!id) continue;
    const person = [l.LAST_NAME, l.NAME].filter(Boolean).join(' ');
    push({
      kind: 'lead', entityId: id, title: l.TITLE?.trim() || person || `Лид #${id}`, url: leadUrl(id),
      subtitle: join(names[`L:${l.STATUS_ID}`] ?? l.STATUS_ID, fmtMoney(l.OPPORTUNITY, l.CURRENCY_ID), `создан ${fmtDate(l.DATE_CREATE) ?? '—'}`),
      meta: { statusId: l.STATUS_ID },
    });
  }
  await sleep(500);

  // ── Контакты ──────────────────────────────────────────────────────────────
  const contacts = await readAll<Record<string, string | null>>('crm.contact.list', {
    filter: { ASSIGNED_BY_ID: sourceId },
    select: ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'COMPANY_ID', 'DATE_CREATE'],
    order: { ID: 'ASC' },
  }, { onPage: tick('contacts') });
  for (const c of contacts) {
    const id = num(c.ID);
    if (!id) continue;
    push({
      kind: 'contact', entityId: id, title: [c.LAST_NAME, c.NAME, c.SECOND_NAME].map(s => s?.trim()).filter(Boolean).join(' ') || `Контакт #${id}`,
      url: contactUrl(id), subtitle: join(`создан ${fmtDate(c.DATE_CREATE) ?? '—'}`), meta: { companyId: num(c.COMPANY_ID) || null },
    });
  }
  await sleep(500);

  // ── Компании ──────────────────────────────────────────────────────────────
  const companies = await readAll<Record<string, string | null>>('crm.company.list', {
    filter: { ASSIGNED_BY_ID: sourceId },
    select: ['ID', 'TITLE', 'DATE_CREATE'],
    order: { ID: 'ASC' },
  }, { onPage: tick('companies') });
  for (const c of companies) {
    const id = num(c.ID);
    if (!id) continue;
    push({ kind: 'company', entityId: id, title: c.TITLE?.trim() || `Компания #${id}`, url: companyUrl(id), subtitle: join(`создана ${fmtDate(c.DATE_CREATE) ?? '—'}`), meta: {} });
  }
  await sleep(500);

  // ── Задачи (только незавершённые) ─────────────────────────────────────────
  const taskSub = (t: BxTask, role?: string) => join(role, TASK_STATUS[num(t.status)] ?? null, t.deadline ? `срок ${fmtDate(t.deadline)}` : 'без срока');
  const alive = (t: BxTask) => ![5, 7].includes(num(t.status));
  const asResp = (await taskList({ RESPONSIBLE_ID: sourceId }, tick('tasks'))).filter(alive);
  for (const t of asResp) {
    const id = num(t.id);
    if (!id) continue;
    const creatorIsSource = num(t.createdBy) === sourceId;
    push({
      kind: 'task_responsible', entityId: id, title: t.title?.trim() || `Задача #${id}`, url: taskUrl(id, sourceId),
      subtitle: taskSub(t, creatorIsSource ? 'исполнитель и постановщик' : 'исполнитель'),
      meta: { status: num(t.status), createdBy: num(t.createdBy), creatorIsSource, groupId: num(t.groupId) || null },
    });
  }
  await sleep(500);
  const asCreator = (await taskList({ CREATED_BY: sourceId, '!RESPONSIBLE_ID': sourceId }, tick('tasks'))).filter(alive);
  for (const t of asCreator) {
    const id = num(t.id);
    if (!id || num(t.responsibleId) === sourceId) continue;
    push({
      kind: 'task_creator', entityId: id, title: t.title?.trim() || `Задача #${id}`, url: taskUrl(id, num(t.responsibleId)),
      subtitle: taskSub(t, 'постановщик'), meta: { status: num(t.status), responsibleId: num(t.responsibleId), groupId: num(t.groupId) || null },
    });
  }
  await sleep(500);
  // Соисполнитель / наблюдатель: одна строка на задачу, роли — в meta (может быть обеими сразу).
  const part = new Map<number, { t: BxTask; roles: Set<'accomplice' | 'auditor'> }>();
  for (const [field, role] of [['ACCOMPLICE', 'accomplice'], ['AUDITOR', 'auditor']] as const) {
    const list = (await taskList({ [field]: sourceId }, tick('tasks'))).filter(alive);
    for (const t of list) {
      const id = num(t.id);
      if (!id || num(t.responsibleId) === sourceId) continue; // исполнитель — уже в task_responsible
      const cur = part.get(id) ?? { t, roles: new Set() };
      cur.roles.add(role);
      part.set(id, cur);
    }
    await sleep(500);
  }
  for (const [id, { t, roles }] of [...part].sort((a, b) => a[0] - b[0])) {
    const label = [roles.has('accomplice') && 'соисполнитель', roles.has('auditor') && 'наблюдатель'].filter(Boolean).join(' и ');
    push({
      kind: 'task_participant', entityId: id, title: t.title?.trim() || `Задача #${id}`, url: taskUrl(id, num(t.responsibleId)),
      subtitle: taskSub(t, label), meta: { status: num(t.status), roles: [...roles], responsibleId: num(t.responsibleId), createdBy: num(t.createdBy) },
    });
  }

  // ── Дела CRM (незавершённые) ──────────────────────────────────────────────
  // Не дела по сути (сверено на живом аккаунте 24.11): TYPE_ID 3 / CRM_TASKS_TASK — отражения задач (их ведёт
  // сама задача, виды task_*); CRM_BIZPROC_WORKFLOW — служебная запись «Бизнес-процесс завершён», висит
  // «невыполненной» вечно (у одного менеджера 39 из 42).
  const NOT_TODO = new Set(['CRM_TASKS_TASK', 'TASKS_TASK', 'TASKS', 'CRM_BIZPROC_WORKFLOW']);
  const acts = await readAll<Record<string, string | null>>('crm.activity.list', {
    filter: { RESPONSIBLE_ID: sourceId, COMPLETED: 'N' },
    select: ['ID', 'SUBJECT', 'TYPE_ID', 'PROVIDER_ID', 'PROVIDER_TYPE_ID', 'OWNER_TYPE_ID', 'OWNER_ID', 'DEADLINE', 'START_TIME', 'DIRECTION'],
    order: { ID: 'ASC' },
  }, { onPage: tick('activities') });
  for (const a of acts) {
    const id = num(a.ID);
    if (!id) continue;
    const typeId = num(a.TYPE_ID);
    if (typeId === 3 || NOT_TODO.has(String(a.PROVIDER_ID ?? ''))) continue;
    const ownerType = num(a.OWNER_TYPE_ID), ownerId = num(a.OWNER_ID);
    const deadline = a.DEADLINE && !String(a.DEADLINE).startsWith('9999') ? fmtDate(a.DEADLINE) : null;
    push({
      kind: 'activity', entityId: id, title: a.SUBJECT?.trim() || `${ACTIVITY_TYPE[typeId] ?? 'Дело'} #${id}`, url: ownerUrl(ownerType, ownerId),
      subtitle: join(a.PROVIDER_ID === 'CRM_TODO' ? 'Дело' : (ACTIVITY_TYPE[typeId] ?? 'Дело'), OWNER_LABEL[ownerType] && `${OWNER_LABEL[ownerType]} #${ownerId}`, deadline ? `срок ${deadline}` : 'без срока'),
      meta: { typeId, providerId: a.PROVIDER_ID, ownerTypeId: ownerType, ownerId },
    });
  }
  return items;
}
