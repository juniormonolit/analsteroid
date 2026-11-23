// PATCH задачи: перетаскивание по доске = смена статуса в Битриксе; перенос слота/срока.
import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { canSeeManager, type SessionScope } from '@/lib/org/sessionScope';
import type { TaskerPatchableStatus, TaskerPatchRequest, TaskerTask } from '../types';
import { bxDate, loadSettings, TaskerError, toMskIso } from './config';
import { drainTask, enqueue, type BxOp } from './bitrix';
import { getTask, getTaskRow, type TaskRow } from './repo';
import { invalidateLive } from './live';

const PATCHABLE: TaskerPatchableStatus[] = ['new', 'in_progress', 'awaiting_control', 'done'];

export function canTouchTask(session: SessionUser, scope: SessionScope, row: TaskRow): boolean {
  const me = session.bitrixUserId ? String(session.bitrixUserId) : null;
  return canSeeManager(scope, row.manager_bitrix_id) || row.creator_user_id === session.id
    || (!!me && (row.rop_bitrix_id === me || row.director_bitrix_id === me || row.manager_bitrix_id === me));
}

export async function patchTask(session: SessionUser, scope: SessionScope, id: number, body: unknown): Promise<{ task: TaskerTask; warning: string | null }> {
  const b = (body ?? {}) as TaskerPatchRequest;
  const row = await getTaskRow(id);
  if (!row || !canTouchTask(session, scope, row)) throw new TaskerError('Задача не найдена', 'forbidden', 404);
  const me = session.bitrixUserId ? String(session.bitrixUserId) : null;
  const isAssignee = me === row.manager_bitrix_id;
  const canManage = hasPerm(session, 'action.tasker.assign');

  const ops: BxOp[] = [];
  const sets: string[] = [];
  const params: unknown[] = [id];

  if (b.status !== undefined) {
    if (!PATCHABLE.includes(b.status)) throw new TaskerError('Недопустимый статус');
    if (!canManage && !isAssignee) throw new TaskerError('Менять статус может исполнитель или постановщик', 'forbidden', 403);
    if (!row.bitrix_task_id) throw new TaskerError('Задача ещё не создана в Битриксе — статус поменять нельзя', 'bitrix', 409);
    ops.push({ op: 'status', target: b.status, asBitrixId: me });
  }

  const fields: Record<string, unknown> = {};
  if (b.slot !== undefined || b.deadline !== undefined) {
    if (!canManage) throw new TaskerError('Переносить сроки может постановщик (право «ставить задачи»)', 'forbidden', 403);
    if (b.slot !== undefined) {
      if (b.slot === null) {
        sets.push('slot_start = NULL', 'slot_end = NULL');
        fields.START_DATE_PLAN = ''; fields.END_DATE_PLAN = '';
      } else {
        const start = toMskIso(b.slot.start, '10:00:00');
        const end = new Date(new Date(start).getTime() + row.duration_min * 60_000).toISOString();
        params.push(start); sets.push(`slot_start = $${params.length}`);
        params.push(end); sets.push(`slot_end = $${params.length}`);
        fields.START_DATE_PLAN = bxDate(start); fields.END_DATE_PLAN = bxDate(end);
      }
    }
    if (b.deadline !== undefined) {
      const dl = toMskIso(b.deadline);
      params.push(dl); sets.push(`deadline = $${params.length}`);
      fields.DEADLINE = bxDate(dl);
    }
    if (row.bitrix_task_id || row.sync_state === 'pending') ops.push({ op: 'update', fields, asBitrixId: me });
  }
  if (!ops.length && !sets.length) throw new TaskerError('Нечего менять');

  if (sets.length) await systemDb().query(`UPDATE tasker_tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  if (b.status !== undefined) {
    // Оптимистично: доска сразу показывает новую колонку; синк перепишет фактическим статусом.
    const optimistic = { new: 2, in_progress: 3, awaiting_control: 4, done: 5 }[b.status];
    await systemDb().query(
      `UPDATE tasker_tasks SET bitrix_status = $2, closed_at = CASE WHEN $2 = 5 THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`, [id, optimistic]);
  }
  await enqueue(id, ops);
  const res = await drainTask(id, { force: true }).catch(e => ({ done: 0, error: e instanceof Error ? e.message : String(e) }));
  invalidateLive((await loadSettings()).groupId);
  const task = await getTask(id);
  if (!task) throw new TaskerError('Задача не найдена', 'forbidden', 404);
  return { task, warning: res.error ? `Битрикс пока не принял изменение (${res.error}) — повторим автоматически` : null };
}
