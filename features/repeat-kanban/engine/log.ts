// Журнал ручных действий в канбане повторных продаж (миграция 231, схема — Fable 20.10).
// Только append. actor_type='user' — действие человека через UI (есть сессия); события
// Битрикса (сдача/приёмка задачи, стадии, звонки) сюда не дублируются — досчитываются из sa.
// Не бросает: сбой журнала не должен ронять действие пользователя.
import { randomUUID } from 'crypto';
import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';

export type KanbanEventType =
  | 'deal_task_created'        // кнопка «Сделка + задача»: создана новая сделка
  | 'deal_returned_from_reject' // сделка возвращена из отказа + задача
  | 'task_created'             // задача в уже открытую сделку
  | 'task_comment_posted'      // комментарий ушёл первым сообщением в чат задачи
  | 'reject_reviewed'          // разбор отказа: payload.decision = brak | no_answer | return
  | 'rejected_direct'          // «Сразу в брак»
  | 'hidden' | 'unhidden'      // «Скрыть из пула» / «Вернуть в пул»
  | 'reject_cleared'           // «Снять брак»
  | 'hide_requested'           // менеджер предложил скрыть (с 21.10 скрывает только РОП)
  | 'hide_request_accepted' | 'hide_request_declined' // решение РОПа по предложению
  | 'manager_reassigned'       // «И сменить менеджера» — запущен БП «Сменить ответственного» (21.10)
  | 'customers_merged' | 'customers_unmerged' | 'customers_split' // склейка заказчиков (миграция 243)
  | 'tags_set'                 // теги заказчика заменены (миграция 245)
  | 'task_accepted' | 'task_accepted_deal_closed' | 'task_returned' // приёмка задачи из канбана (22.10)
  | 'task_replaced';           // «Откатить и создать задачу»: сделка задачи закрыта, поставлена новая, старая принята (23.10)

export const newRequestId = () => randomUUID();

export async function logEvent(session: SessionUser, e: {
  type: KanbanEventType; requestId: string; clientKey?: string | null; managerId?: string | null;
  columnBefore?: string | null; dealId?: number | null; taskId?: number | null; payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    await systemDb().query(
      `INSERT INTO repeat_kanban_events (request_id, actor_type, actor_login, actor_name, actor_bitrix_id, actor_role,
                                         event_type, client_key, manager_id, column_before, deal_id, task_id, payload)
       VALUES ($1, 'user', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [e.requestId, session.login, session.displayName, session.bitrixUserId, session.roleName,
       e.type, e.clientKey ?? null, e.managerId ?? null, e.columnBefore ?? null, e.dealId ?? null, e.taskId ?? null,
       JSON.stringify(e.payload ?? {})],
    );
  } catch (err) {
    console.warn('[repeat-kanban] журнал не записался:', err instanceof Error ? err.message : err);
  }
}
