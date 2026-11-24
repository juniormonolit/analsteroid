// Исполнитель одной строки «Увольнятора». Перед записью — СВЕЖЕЕ чтение сущности: если она уже не на
// уволенном (БП 171 по сделке мог перепривязать контакт/компанию, кто-то передал руками) — skipped с
// понятной причиной. После записи — контрольное чтение: Битрикс иногда отвечает true и ничего не меняет.
//
// Сделки — ТОЛЬКО бизнес-процессом «Сменить ответственного» (REASSIGN_TEMPLATE_ID = 171), crm.deal.update
// ASSIGNED_BY_ID запрещён владельцем. Автобрак первички (v2) — crm.deal.update ТОЛЬКО STAGE_ID (вебхук записи
// CRM), ответственный не меняется, БП не запускается. Задачи — tasks.task.update / complete (+approve при контроле постановщика). Дела — crm.activity.update
// (дело нового типа CRM_TODO — смена ответственного через crm.activity.todo.updateResponsibleUser).
//
// Вызовы Битрикса идут через pace(): воркер держит паузы между ними (≥700 мс, после БП — ≥1.5 с).
import { REASSIGN_TEMPLATE_ID } from '@/features/repeat-kanban/engine/createDeal';
import { PRIMARY_BRAK_STAGE, type DismissalAction, type DismissalKind } from '../types';
import { readOne, writeCrm, writeTask } from './bx';

export interface ExecItem {
  key: string;
  kind: DismissalKind;
  entityId: number;
  action: DismissalAction;
  target: number | null;
  meta: Record<string, unknown>;
}
export interface ExecResult { status: 'done' | 'skipped'; detail: string }
export type Pace = (what: 'call' | 'bp') => Promise<void>;

/** Отказ, который повтором не лечится (сущность в неожиданном состоянии после записи и т.п.). */
export class DismissalItemError extends Error {}

const num = (v: unknown) => Number(v) || 0;
const done = (detail: string): ExecResult => ({ status: 'done', detail });
const skipped = (detail: string): ExecResult => ({ status: 'skipped', detail });

/** «Уже не на нём»: у получателя — считаем сделанным (повтор после таймаута), у третьего — пропуск. */
function notOnSource(current: number, target: number | null, what: string): ExecResult {
  if (target && current === target) return done(`${what} уже у получателя`);
  return skipped(current ? `${what} уже на другом сотруднике (#${current}) — не трогали` : `${what}: ответственный пуст — не трогали`);
}

async function get<T>(pace: Pace, method: string, params: Record<string, unknown>): Promise<T | null> {
  await pace('call');
  try {
    return await readOne<T>(method, params);
  } catch (e) {
    // «Не найдено» — сущность удалена: это пропуск, а не ошибка прогона.
    const m = e instanceof Error ? e.message : String(e);
    if (/not found|не найден|NOT_FOUND/i.test(m) && !/QUERY_LIMIT/i.test(m)) return null;
    throw e;
  }
}

// ── Сделки ──────────────────────────────────────────────────────────────────
interface BxDeal { ASSIGNED_BY_ID?: string; STAGE_ID?: string; CATEGORY_ID?: string; CLOSED?: string; STAGE_SEMANTIC_ID?: string }
const dealOpen = (d: BxDeal) => d.CLOSED !== 'Y' && (d.STAGE_SEMANTIC_ID ?? 'P') === 'P';

async function execDeal(it: ExecItem, sourceId: number, pace: Pace): Promise<ExecResult> {
  const d = await get<BxDeal>(pace, 'crm.deal.get', { id: it.entityId });
  if (!d) return skipped('Сделка не найдена (удалена?)');
  const cur = num(d.ASSIGNED_BY_ID);
  if (cur !== sourceId) return notOnSource(cur, it.target, 'Сделка');
  if (!dealOpen(d)) return skipped('Сделка уже закрыта — не трогали');
  await pace('bp');
  const wf = await writeTask<string>('bizproc.workflow.start', {
    TEMPLATE_ID: REASSIGN_TEMPLATE_ID,
    DOCUMENT_ID: ['crm', 'CCrmDocumentDeal', `DEAL_${it.entityId}`],
    PARAMETERS: { new_responsible_id: `user_${it.target}` },
  });
  // БП отрабатывает асинхронно — контрольное чтение сразу могло бы увидеть старого ответственного.
  return done(`Запущен БП «Сменить ответственного» (${String(wf)})`);
}

/** Автобрак первички: только стадия. Перед записью — всё ещё его и всё ещё открыта. */
async function execBrak(it: ExecItem, sourceId: number, pace: Pace): Promise<ExecResult> {
  const d = await get<BxDeal>(pace, 'crm.deal.get', { id: it.entityId });
  if (!d) return skipped('Сделка не найдена (удалена?)');
  const stage = PRIMARY_BRAK_STAGE[num(d.CATEGORY_ID)];
  if (!stage) throw new DismissalItemError(`В воронке ${num(d.CATEGORY_ID)} нет стадии автобрака`);
  if (d.STAGE_ID === stage) return done('Сделка уже в автобраке');
  const cur = num(d.ASSIGNED_BY_ID);
  if (cur !== sourceId) return skipped(cur ? `Сделка уже на другом сотруднике (#${cur}) — в автобрак не переводили` : 'Ответственный пуст — не трогали');
  if (!dealOpen(d)) return skipped('Сделка уже закрыта — не трогали');
  await pace('call');
  await writeCrm<boolean>('crm.deal.update', { id: it.entityId, fields: { STAGE_ID: stage } });
  const after = await get<BxDeal>(pace, 'crm.deal.get', { id: it.entityId });
  if (after && after.STAGE_ID !== stage) throw new DismissalItemError(`Битрикс принял запись, но стадия — ${after.STAGE_ID}`);
  return done('Переведена в автобрак');
}

// ── Задачи ──────────────────────────────────────────────────────────────────
interface BxTask { id: string; status?: string; responsibleId?: string; createdBy?: string; accomplices?: string[]; auditors?: string[]; taskControl?: string }
async function getTask(pace: Pace, id: number): Promise<BxTask | null> {
  const r = await get<{ task?: BxTask }>(pace, 'tasks.task.get', { taskId: id, select: ['ID', 'STATUS', 'RESPONSIBLE_ID', 'CREATED_BY', 'ACCOMPLICES', 'AUDITORS', 'TASK_CONTROL'] });
  return r?.task ?? null;
}
const ids = (a: unknown) => (Array.isArray(a) ? a : a && typeof a === 'object' ? Object.values(a) : []).map(num).filter(Boolean);
const finished = (t: BxTask) => [5, 7].includes(num(t.status));

async function updateTask(pace: Pace, taskId: number, fields: Record<string, unknown>) {
  await pace('call');
  await writeTask<unknown>('tasks.task.update', { taskId, fields });
}

/** Довести задачу до «завершена»: complete; при контроле постановщика она станет «ждёт контроля» (4) → approve. */
async function closeTask(pace: Pace, t: BxTask): Promise<string> {
  const taskId = num(t.id);
  if (num(t.status) !== 4) { await pace('call'); await writeTask<unknown>('tasks.task.complete', { taskId }); }
  const after = await getTask(pace, taskId);
  if (after && num(after.status) === 5) return 'Задача завершена';
  await pace('call');
  await writeTask<unknown>('tasks.task.approve', { taskId });
  const fin = await getTask(pace, taskId);
  if (fin && num(fin.status) !== 5) throw new DismissalItemError(`Задача не закрылась: статус ${num(fin.status)}`);
  return 'Задача завершена (принята за постановщика)';
}

async function execTask(it: ExecItem, sourceId: number, pace: Pace): Promise<ExecResult> {
  const t = await getTask(pace, it.entityId);
  if (!t) return skipped('Задача не найдена (удалена?)');
  // Задачи сделки: БП 171 сам завершает робот-задачи ЧЛ/ЮЛ — это не ошибка.
  if (finished(t)) return skipped(it.kind === 'task_deal' ? 'Задача уже закрыта (закрыл БП сделки или вручную)' : 'Задача уже завершена');
  const resp = num(t.responsibleId), creator = num(t.createdBy);

  if (it.kind === 'task_deal' || it.kind === 'task_other') {
    if (resp !== sourceId) return notOnSource(resp, it.action === 'transfer' ? it.target : null, 'Задача');
    if (it.action === 'close') return done(await closeTask(pace, t));
    // Он же постановщик — постановщиком тоже ставим получателя: иначе задача «своя себе» уволенного
    // остаётся с мёртвым постановщиком (контроль/приёмку некому сделать).
    const fields: Record<string, unknown> = { RESPONSIBLE_ID: it.target };
    if (creator === sourceId) fields.CREATED_BY = it.target;
    await updateTask(pace, it.entityId, fields);
    const after = await getTask(pace, it.entityId);
    if (after && num(after.responsibleId) !== it.target) throw new DismissalItemError(`Битрикс принял запись, но исполнитель — #${num(after.responsibleId)}`);
    return done(creator === sourceId ? 'Исполнитель и постановщик сменены' : 'Исполнитель сменён');
  }

  if (it.kind === 'task_creator') {
    if (creator !== sourceId) return notOnSource(creator, it.target, 'Постановщик задачи');
    await updateTask(pace, it.entityId, { CREATED_BY: it.target });
    const after = await getTask(pace, it.entityId);
    if (after && num(after.createdBy) !== it.target) throw new DismissalItemError(`Битрикс принял запись, но постановщик — #${num(after.createdBy)}`);
    return done('Постановщик сменён');
  }

  // task_participant: remove — убрать из соисполнителей и наблюдателей; transfer — заменить на получателя в той же роли.
  const acc = ids(t.accomplices), aud = ids(t.auditors);
  if (!acc.includes(sourceId) && !aud.includes(sourceId)) return skipped('Уже не соисполнитель и не наблюдатель');
  const swap = (list: number[]) => {
    if (!list.includes(sourceId)) return null;
    const rest = list.filter(x => x !== sourceId);
    // Получатель — исполнитель задачи: в соисполнители/наблюдатели его не добавляем, просто убираем уволенного.
    if (it.action === 'transfer' && it.target && it.target !== resp && !rest.includes(it.target)) rest.push(it.target);
    return rest;
  };
  const fields: Record<string, unknown> = {};
  const na = swap(acc), nu = swap(aud);
  if (na) fields.ACCOMPLICES = na;
  if (nu) fields.AUDITORS = nu;
  await updateTask(pace, it.entityId, fields);
  const after = await getTask(pace, it.entityId);
  if (after && (ids(after.accomplices).includes(sourceId) || ids(after.auditors).includes(sourceId))) {
    throw new DismissalItemError('Битрикс принял запись, но уволенный остался в участниках');
  }
  const roles = [na && 'соисполнители', nu && 'наблюдатели'].filter(Boolean).join(', ');
  return done(it.action === 'transfer' ? `Заменён на получателя (${roles})` : `Убран (${roles})`);
}

// ── Дела CRM ────────────────────────────────────────────────────────────────
interface BxActivity { ID: string; RESPONSIBLE_ID?: string; COMPLETED?: string; PROVIDER_ID?: string; OWNER_TYPE_ID?: string; OWNER_ID?: string }
async function execActivity(it: ExecItem, sourceId: number, pace: Pace): Promise<ExecResult> {
  const a = await get<BxActivity>(pace, 'crm.activity.get', { id: it.entityId });
  if (!a) return skipped('Дело не найдено (удалено?)');
  if (a.COMPLETED === 'Y') return skipped('Дело уже выполнено');
  // Дела сделки БП 171 переводит сам — тогда здесь «уже у получателя».
  const cur = num(a.RESPONSIBLE_ID);
  if (cur !== sourceId) return notOnSource(cur, it.action === 'transfer' ? it.target : null, 'Дело');
  if (it.action === 'close') {
    await pace('call');
    await writeCrm<boolean>('crm.activity.update', { id: it.entityId, fields: { COMPLETED: 'Y' } });
    const after = await get<BxActivity>(pace, 'crm.activity.get', { id: it.entityId });
    if (after && after.COMPLETED !== 'Y') throw new DismissalItemError('Битрикс принял запись, но дело не отмечено выполненным');
    return done('Дело отмечено выполненным');
  }
  await pace('call');
  if (a.PROVIDER_ID === 'CRM_TODO') {
    await writeCrm<unknown>('crm.activity.todo.updateResponsibleUser', {
      ownerTypeId: num(a.OWNER_TYPE_ID), ownerId: num(a.OWNER_ID), id: it.entityId, responsibleId: it.target,
    });
  } else {
    await writeCrm<boolean>('crm.activity.update', { id: it.entityId, fields: { RESPONSIBLE_ID: it.target } });
  }
  const after = await get<BxActivity>(pace, 'crm.activity.get', { id: it.entityId });
  if (after && num(after.RESPONSIBLE_ID) !== it.target) throw new DismissalItemError(`Битрикс принял запись, но ответственный дела — #${num(after.RESPONSIBLE_ID)}`);
  return done('Ответственный дела сменён');
}

/** Исполнить строку. Бросает: isTransient(e) — повторить позже, иначе — ошибка строки.
 *  follow сюда не приходит — start разворачивает его в transfer / close / skip. */
export async function executeItem(it: ExecItem, sourceId: number, pace: Pace): Promise<ExecResult> {
  if (it.action === 'skip') return skipped('По правилу: не трогать');
  if (it.action === 'follow') throw new DismissalItemError('«Вслед за сделкой» не развёрнуто — перезапустите прогон');
  if (it.action === 'transfer' && !it.target) throw new DismissalItemError('Не указан получатель');
  if (it.action === 'transfer' && it.target === sourceId) throw new DismissalItemError('Получатель — сам увольняемый');
  switch (it.kind) {
    case 'deal_primary':
    case 'deal_repeat':
      if (it.action === 'brak' && it.kind === 'deal_primary') return execBrak(it, sourceId, pace);
      if (it.action !== 'transfer') throw new DismissalItemError(`Для сделки действие ${it.action} недопустимо`);
      return execDeal(it, sourceId, pace);
    case 'task_deal':
    case 'task_other':
    case 'task_creator':
    case 'task_participant':
      return execTask(it, sourceId, pace);
    case 'activity_deal':
    case 'activity_other':
      return execActivity(it, sourceId, pace);
    default:
      throw new DismissalItemError(`Вид строки ${String(it.kind)} не поддерживается (прогон до v2) — пересоберите`);
  }
}
