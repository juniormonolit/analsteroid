// Задачи РОПа менеджеру по заказчику (канбан повторных продаж). Живут в системной БД
// (миграция 230), не в Битриксе. «Прочитано» ставится, когда менеджер открыл задачу,
// «выполнено» — его отметкой; был ли звонок, доска смотрит по va.calls сама.
import { systemDb } from '@/lib/db/clients';
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';
import type { SessionUser } from '@/lib/auth/session';

export interface RepeatTask {
  id: number;
  clientKey: string;
  dealId: number | null;
  managerBitrixId: string;
  text: string;
  dueAt: string | null;
  createdBy: string;
  createdAt: string;
  readAt: string | null;
  doneAt: string | null;
  doneComment: string | null;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

function toTask(r: Record<string, unknown>): RepeatTask {
  return {
    id: Number(r.id), clientKey: String(r.client_key), dealId: r.deal_id !== null ? Number(r.deal_id) : null,
    managerBitrixId: String(r.manager_bitrix_id), text: String(r.text), dueAt: iso(r.due_at),
    createdBy: String(r.created_by), createdAt: iso(r.created_at)!, readAt: iso(r.read_at), doneAt: iso(r.done_at),
    doneComment: (r.done_comment as string | null) ?? null,
  };
}

/** Последняя (неотменённая) задача по каждому заказчику. */
export async function fetchTasksForClients(keys: string[]): Promise<Map<string, RepeatTask>> {
  if (!keys.length) return new Map();
  try {
    const r = await systemDb().query(
      `SELECT DISTINCT ON (client_key) * FROM repeat_kanban_tasks
        WHERE client_key = ANY($1::text[]) AND cancelled_at IS NULL
        ORDER BY client_key, created_at DESC`,
      [keys],
    );
    return new Map(r.rows.map(x => [String(x.client_key), toTask(x)]));
  } catch { return new Map(); } // до миграции 230
}

export async function getTask(id: number): Promise<RepeatTask | null> {
  const r = await systemDb().query(`SELECT * FROM repeat_kanban_tasks WHERE id = $1`, [id]);
  return r.rows[0] ? toTask(r.rows[0]) : null;
}

/** Открытые задачи менеджера — его список «что поручил РОП». */
export async function listOpenTasks(managerBitrixId: string): Promise<RepeatTask[]> {
  try {
    const r = await systemDb().query(
      `SELECT * FROM repeat_kanban_tasks WHERE manager_bitrix_id = $1 AND done_at IS NULL AND cancelled_at IS NULL
        ORDER BY created_at DESC LIMIT 200`,
      [managerBitrixId],
    );
    return r.rows.map(toTask);
  } catch { return []; }
}

const appUrl = () => (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.com').replace(/\/$/, '');

export async function createTask(input: {
  clientKey: string; clientName: string | null; dealId: number | null; managerBitrixId: string;
  text: string; dueAt: string | null; session: SessionUser;
}): Promise<RepeatTask> {
  // Новая задача по заказчику заменяет прежнюю незакрытую — на карточке одна актуальная.
  const db = systemDb();
  await db.query(
    `UPDATE repeat_kanban_tasks SET cancelled_at = now() WHERE client_key = $1 AND done_at IS NULL AND cancelled_at IS NULL`,
    [input.clientKey],
  );
  const r = await db.query(
    `INSERT INTO repeat_kanban_tasks (client_key, deal_id, manager_bitrix_id, text, due_at, created_by, created_by_user_id, created_by_bitrix_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [input.clientKey, input.dealId, input.managerBitrixId, input.text.trim().slice(0, 2000), input.dueAt,
     input.session.displayName, input.session.id, input.session.bitrixUserId],
  );
  const task = toTask(r.rows[0]);
  const due = task.dueAt ? `\nСрок: ${new Date(task.dueAt).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}` : '';
  const deal = task.dealId ? `\nСделка: https://td.monolit-crm.ru/crm/deal/details/${task.dealId}/` : '';
  const msg = `[b]Задача от ${input.session.displayName}[/b]\nЗаказчик: ${input.clientName ?? input.clientKey}\n${task.text}${due}${deal}\n\nОткрыть и отметить: ${appUrl()}/repeat-kanban?task=${task.id}`;
  // Не бросаем: задача уже записана, недоставленное сообщение видно на карточке («не прочитана»).
  sendBitrixBotMessage(input.managerBitrixId, msg, undefined, 'repeat_tasks').catch(e =>
    console.warn('[repeat-kanban] уведомление о задаче не ушло:', e instanceof Error ? e.message : e));
  return task;
}

/** Менеджер открыл задачу. Ставится только исполнителем — РОП, открывший карточку, «прочитано» не ставит. */
export async function markTaskRead(id: number, bitrixUserId: string): Promise<void> {
  await systemDb().query(
    `UPDATE repeat_kanban_tasks SET read_at = now() WHERE id = $1 AND manager_bitrix_id = $2 AND read_at IS NULL`,
    [id, bitrixUserId],
  );
}

export async function markTaskDone(id: number, bitrixUserId: string, comment: string | null): Promise<RepeatTask | null> {
  const r = await systemDb().query(
    `UPDATE repeat_kanban_tasks SET done_at = now(), read_at = coalesce(read_at, now()), done_comment = $3
      WHERE id = $1 AND manager_bitrix_id = $2 AND done_at IS NULL AND cancelled_at IS NULL RETURNING *`,
    [id, bitrixUserId, comment?.trim().slice(0, 1000) || null],
  );
  return r.rows[0] ? toTask(r.rows[0]) : null;
}
