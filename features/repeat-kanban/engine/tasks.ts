// Задачи канбана повторных продаж — задачи Битрикса в проекте «Повторные продажи»
// (группа 118; ТЗ старого канбана, решение владельца 20.10). Читаем копию
// sa.bitrix_task_current — туда же попадают задачи, поставленные старым канбаном
// /crm/mltclients/, поэтому на карточке видны обе. Свою таблицу задач (миграция 230,
// repeat_kanban_tasks) больше не пишем.
//
// Статусы Битрикса: 1 новая, 2 ждёт выполнения, 3 выполняется, 4 ждёт контроля,
// 5 завершена, 6 отложена. status_view = -2 — «не просмотрена» исполнителем.
import { analyticsDb } from '@/lib/db/clients';
import { REPEAT_PROJECT_GROUP_ID } from './config';

export type RepeatTaskState = 'unread' | 'pending' | 'in_progress' | 'control' | 'done' | 'deferred';

export interface RepeatTask {
  id: number;
  dealId: number;
  title: string;
  state: RepeatTaskState;
  createdById: string | null;
  createdByName: string | null;
  responsibleId: string | null;
  responsibleName: string | null;
  createdAt: string;
  deadlineAt: string | null;
  /** Последнее изменение (для «ждёт контроля N дней»). */
  changedAt: string | null;
  closedAt: string | null;
}

function stateOf(status: number | null, view: number | null): RepeatTaskState {
  if (status === 5) return 'done';
  if (status === 4) return 'control';
  if (status === 6) return 'deferred';
  if (status === 3) return 'in_progress';
  if (view === -2) return 'unread';
  return 'pending';
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/** Последняя задача проекта по каждой сделке. */
export async function fetchTasksForDeals(dealIds: number[]): Promise<Map<number, RepeatTask>> {
  if (!dealIds.length) return new Map();
  try {
    const r = await analyticsDb().query(
      `SELECT DISTINCT ON (t.deal_id) t.task_id, t.deal_id, t.title, t.status, t.status_view, t.created_by, t.responsible_id,
              t.responsible_name, t.created_at, t.deadline_at, t.changed_at, t.closed_at, org.manager_name AS created_by_name
         FROM sa.bitrix_task_current t
         LEFT JOIN sa.org_resolved_hierarchy org ON org.manager_bitrix_user_id = t.created_by::text
        WHERE t.group_id = $2 AND NOT t.is_deleted AND t.deal_id = ANY($1::bigint[])
        ORDER BY t.deal_id, t.created_at DESC`,
      [dealIds, REPEAT_PROJECT_GROUP_ID],
    );
    return new Map(r.rows.map(x => [Number(x.deal_id), {
      id: Number(x.task_id), dealId: Number(x.deal_id), title: String(x.title ?? ''),
      state: stateOf(x.status !== null ? Number(x.status) : null, x.status_view !== null ? Number(x.status_view) : null),
      createdById: x.created_by !== null ? String(x.created_by) : null, createdByName: x.created_by_name ?? null,
      responsibleId: x.responsible_id !== null ? String(x.responsible_id) : null, responsibleName: x.responsible_name ?? null,
      createdAt: iso(x.created_at)!, deadlineAt: iso(x.deadline_at), changedAt: iso(x.changed_at), closedAt: iso(x.closed_at),
    }]));
  } catch (e) {
    console.warn('[repeat-kanban] задачи проекта не прочитались:', e instanceof Error ? e.message : e);
    return new Map();
  }
}
