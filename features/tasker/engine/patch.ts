// PATCH задачи: смена статуса (перетаскивание по доске / кнопки карточки = смена в Битриксе); перенос слота/срока.
// Правка 23.11 (TASKER_FEEDBACK_2026-11-23.md п.2–3): «Ждёт контроля» нет — исполнитель завершает сам, но
// обязательно с «Что сделано» (комментарий в задачу Битрикса + done_note); ошибочное завершение можно откатить,
// пока нет вердикта замера. Менеджер — объект задачи — статус не меняет.
import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { canSeeManager, type SessionScope } from '@/lib/org/sessionScope';
import type { TaskerPatchableStatus, TaskerPatchRequest, TaskerTask } from '../types';
import { bxDate, loadSettings, TaskerError, toMskIso } from './config';
import { drainTask, enqueue, type BxOp } from './bitrix';
import { canChangeStatusOf, getTask, getTaskRow, viewerOf, type TaskRow } from './repo';
import { invalidateLive } from './live';
import { hardConflictMessage } from './availability';

const PATCHABLE: TaskerPatchableStatus[] = ['new', 'in_progress', 'done'];
export const MIN_DONE_NOTE = 10;

/** Видит задачу (и может к ней обращаться): срез, постановщик, исполнитель, РОП, директор, наблюдатель, сам менеджер. */
export function canTouchTask(session: SessionUser, scope: SessionScope, row: TaskRow): boolean {
  const me = session.bitrixUserId ? String(session.bitrixUserId) : null;
  return canSeeManager(scope, row.manager_bitrix_id) || row.creator_user_id === session.id
    || (!!me && (row.rop_bitrix_id === me || row.director_bitrix_id === me || row.manager_bitrix_id === me
      || row.executor_bitrix_id === me || row.creator_bitrix_id === me || (row.auditor_ids ?? []).includes(me)));
}

const isClosed = (row: TaskRow) => row.done_at !== null || [4, 5, 7].includes(Number(row.bitrix_status ?? 0));

export async function patchTask(session: SessionUser, scope: SessionScope, id: number, body: unknown): Promise<{ task: TaskerTask; warning: string | null }> {
  const b = (body ?? {}) as TaskerPatchRequest;
  const row = await getTaskRow(id);
  if (!row || !canTouchTask(session, scope, row)) throw new TaskerError('Задача не найдена', 'forbidden', 404);
  const viewer = viewerOf(session);
  const me = viewer.bitrixId;
  const mayChange = canChangeStatusOf(row, viewer);

  const ops: BxOp[] = [];
  const sets: string[] = [];
  const params: unknown[] = [id];
  const who = session.displayName || 'пользователь Монолитики';

  if (b.status !== undefined) {
    if (!PATCHABLE.includes(b.status)) throw new TaskerError('Недопустимый статус');
    if (!mayChange) throw new TaskerError('Менять статус может исполнитель (РОП или тренер) или постановщик; менеджеру задача видна только для чтения', 'forbidden', 403);
    if (row.verdict) throw new TaskerError('По задаче уже есть итог замера — вернуть нельзя. Нужен новый подход — поставьте новую задачу', 'bad_request', 409);
    if (!row.bitrix_task_id) throw new TaskerError('Задача ещё не создана в Битриксе — статус поменять нельзя', 'bitrix', 409);
    if (b.status === 'done') {
      const note = typeof b.doneNote === 'string' ? b.doneNote.trim().slice(0, 4000) : '';
      if (note.length < MIN_DONE_NOTE) throw new TaskerError('Опишите, что сделано: например, «обработано 14 сделок, проверены брони…»');
      params.push(note); sets.push(`done_note = $${params.length}`);
      sets.push('done_at = now()');
      params.push(who); sets.push(`done_by = $${params.length}`);
      ops.push({ op: 'comment', text: `[B]Что сделано[/B] (${who}):\n${note}` });
    } else if (isClosed(row)) {
      // Откат ошибочного завершения: снова в работе, резюме снимаем (при новом завершении напишут заново).
      sets.push('done_note = NULL', 'done_at = NULL', 'done_by = NULL');
      ops.push({ op: 'comment', text: `[COLOR=#999999]Завершение отменено (${who}) — задача снова в работе.[/COLOR]` });
    }
    ops.push({ op: 'status', target: b.status, asBitrixId: me });
  }

  const fields: Record<string, unknown> = {};
  if (b.slot !== undefined || b.deadline !== undefined) {
    if (!viewer.canManage && row.executor_bitrix_id !== me) throw new TaskerError('Переносить сроки может исполнитель или постановщик', 'forbidden', 403);
    if (b.slot !== undefined) {
      if (b.slot === null) {
        sets.push('slot_start = NULL', 'slot_end = NULL');
        fields.START_DATE_PLAN = ''; fields.END_DATE_PLAN = '';
      } else {
        const start = toMskIso(b.slot.start, '10:00:00');
        const end = new Date(new Date(start).getTime() + row.duration_min * 60_000).toISOString();
        // Собрание 26.11, п.3: у исполнителя и менеджера не бывает двух работ Задачника в одно время.
        const exec = row.executor_bitrix_id && row.executor_bitrix_id !== row.manager_bitrix_id ? row.executor_bitrix_id : row.rop_bitrix_id;
        const msg = await hardConflictMessage(
          [...(exec && !row.training_event_id ? [{ id: exec, role: 'Исполнитель' }] : []), { id: row.manager_bitrix_id, role: 'Менеджер' }],
          [{ start: Date.parse(start), end: Date.parse(end) }], { taskId: id, sessionId: row.session_id ? Number(row.session_id) : null });
        if (msg) throw new TaskerError(`Время занято — перенос не сохранён. ${msg}`, 'bad_request', 409);
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
    // Слот задачи без сессии = событие в календаре исполнителя (менеджер — участник).
    if (b.slot !== undefined && !row.session_id) ops.push({ op: 'task_calendar' });
  }
  if (!ops.length && !sets.length) throw new TaskerError('Нечего менять');

  if (sets.length) await systemDb().query(`UPDATE tasker_tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  if (b.status !== undefined) {
    // Оптимистично: доска сразу показывает новую колонку; синк перепишет фактическим статусом.
    const optimistic = { new: 2, in_progress: 3, done: 5 }[b.status];
    await systemDb().query(
      `UPDATE tasker_tasks SET bitrix_status = $2, closed_at = CASE WHEN $2 = 5 THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`, [id, optimistic]);
  }
  await enqueue(id, ops);
  const res = await drainTask(id, { force: true }).catch(e => ({ done: 0, error: e instanceof Error ? e.message : String(e) }));
  invalidateLive((await loadSettings()).groupId);
  const task = await getTask(id, viewer);
  if (!task) throw new TaskerError('Задача не найдена', 'forbidden', 404);
  return { task, warning: res.error ? `Битрикс пока не принял изменение (${res.error}) — повторим автоматически` : null };
}
