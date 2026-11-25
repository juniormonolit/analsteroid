// «Большой брат» — маппинг мутаций сервисов (Задачник, канбан больших, канбан логистов) в mono_action.
// Роуты зовут одну функцию после успешного действия: `void logXxx(session, …)` — не ждём, не бросает.
// Канбан повторки сюда НЕ пишет: у него свой журнал repeat_kanban_events (читается адаптером, kind='kanban').
// Исходная операция сервиса — всегда в payload.op, чтобы читатели могли уточнить действие.
import type { SessionUser } from '@/lib/auth/session';
import { logActivity } from './log';
import type { MonoAction } from './types';

type S = SessionUser | null | undefined;
type TaskLike = { id: number; bitrixTaskId?: number | null; dealId?: number | null };

// ── Задачник ─────────────────────────────────────────────────────────────────────────────

/** POST /api/tasker/tasks и /api/tasker/deal-tasks: по событию на созданную задачу. */
export async function logTaskerCreated(s: S, created: TaskLike[], via: 'metric' | 'deal'): Promise<void> {
  await Promise.all(created.slice(0, 50).map(t => logActivity(s, {
    kind: 'mono_action', section: 'tasker', action: 'task_create', entityType: 'tasker_task', entityId: t.id,
    dealId: t.dealId ?? null, payload: { op: via === 'deal' ? 'create_deal_task' : 'create', bitrix_task_id: t.bitrixTaskId ?? null },
  })));
}

/** PATCH /api/tasker/tasks/:id — статус / слот / срок. */
export async function logTaskerPatched(s: S, task: TaskLike, body: unknown): Promise<void> {
  const b = (body ?? {}) as { status?: string; slot?: unknown; deadline?: unknown };
  const action: MonoAction = b.status === 'done' ? 'task_close'
    : b.status ? 'task_update'
    : b.deadline !== undefined || b.slot !== undefined ? 'task_reschedule' : 'task_update';
  await logActivity(s, {
    kind: 'mono_action', section: 'tasker', action, entityType: 'tasker_task', entityId: task.id, dealId: task.dealId ?? null,
    payload: { op: b.status ? `status:${b.status}` : b.deadline !== undefined ? 'deadline' : b.slot !== undefined ? 'slot' : 'patch', bitrix_task_id: task.bitrixTaskId ?? null },
  });
}

/** PATCH /api/tasker/sessions/:id — сессия разбора (done / undone / reschedule). */
export async function logTaskerSession(s: S, id: number, body: unknown): Promise<void> {
  const op = String((body as { action?: unknown } | null)?.action ?? 'patch');
  await logActivity(s, {
    kind: 'mono_action', section: 'tasker', action: op === 'reschedule' ? 'task_reschedule' : op === 'done' ? 'task_close' : 'task_update',
    entityType: 'tasker_session', entityId: id, payload: { op: `session:${op}` },
  });
}

/** Собрания Задачника: create / update / cancel. */
export async function logTaskerMeeting(s: S, id: number, op: 'create' | 'update' | 'cancel'): Promise<void> {
  await logActivity(s, {
    kind: 'mono_action', section: 'tasker', action: op === 'create' ? 'task_create' : op === 'cancel' ? 'task_delete' : 'task_update',
    entityType: 'tasker_meeting', entityId: id, payload: { op: `meeting:${op}` },
  });
}

// ── Канбан больших чеков ─────────────────────────────────────────────────────────────────

const BIG_ACTIONS: Record<string, MonoAction> = {
  move: 'deal_move', reassign: 'task_update', participants: 'task_update', comment: 'task_comment',
  related_comment: 'task_comment', accept: 'task_close', approve: 'task_close', complete: 'task_close',
  return: 'task_return', renew: 'task_create', deadline: 'task_reschedule',
};

/** POST /api/big-deals-kanban/action. */
export async function logBigAction(s: S, body: { type: string; taskId?: unknown; column?: unknown; toColumn?: unknown }, dealId?: number | null): Promise<void> {
  await logActivity(s, {
    kind: 'mono_action', section: 'big_deals', action: BIG_ACTIONS[body.type] ?? 'other',
    entityType: 'bitrix_task', entityId: Number(body.taskId) || null, dealId: dealId ?? null, payload: { op: body.type },
  });
}

/** Прочие мутации канбана больших: массовое закрытие, комментарий к карточке. */
export async function logBigOther(s: S, op: 'mass_close' | 'note', p: { taskId?: number | null; count?: number | null } = {}): Promise<void> {
  await logActivity(s, {
    kind: 'mono_action', section: 'big_deals', action: op === 'mass_close' ? 'task_close' : 'task_comment',
    entityType: p.taskId ? 'bitrix_task' : null, entityId: p.taskId ?? null, payload: { op, ...(p.count != null ? { count: p.count } : {}) },
  });
}

// ── Канбан логистов ──────────────────────────────────────────────────────────────────────

const LOGIST_ACTIONS: Record<string, MonoAction> = {
  update_draft: 'request_update', send: 'request_create', take: 'request_assign', release: 'request_assign',
  transfer: 'request_assign', reassign: 'request_assign', answer: 'request_update', withdraw_offer: 'request_update',
  return: 'request_update', accept: 'request_update', cancel: 'request_update', add_items: 'request_update',
  create_draft: 'request_create', message: 'task_comment',
};

/** Действие с запросом логисту (action / PATCH черновика / сообщение / создание). */
export async function logLogist(s: S, op: string, requestId: number | null | undefined, dealId?: number | null): Promise<void> {
  await logActivity(s, {
    kind: 'mono_action', section: 'logist', action: LOGIST_ACTIONS[op] ?? 'other',
    entityType: 'logist_request', entityId: requestId ?? null, dealId: dealId ?? null, payload: { op },
  });
}
