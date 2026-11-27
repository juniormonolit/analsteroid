// Действия у сессии исполнителя (UX-аудит 23.11, п.39; миграция 283):
//  - «Провёл» (done) / снять отметку (undone) — held_at/held_by на сессии; задачи сессии НЕ закрываются
//    (их исполнитель завершает с «Что сделано», patch.ts);
//  - «Перенести» (reschedule) — новый слот: tasker_sessions.slot_start/duration_min, у задач сессии — слот и
//    START/END_DATE_PLAN в Битриксе (op update), событие календаря — op calendar (calendar.event.update, calendar.ts).
//    Занятость в новое время проверяется (checkAvailability) и возвращается предупреждением — не запретом.
// Права: исполнитель сессии (РОП/тренер), его директор по продажам, админ (repo.ts canManageSession).
import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { canSeeManager, type SessionScope } from '@/lib/org/sessionScope';
import { getEmployeeDirectory } from '@/lib/org/employeeDirectory';
import type { TaskerSessionPatchRequest, TaskerSessionPatchResponse } from '../types';
import { bxDate, loadSettings, TaskerError } from './config';
import { drainTask, enqueue, type BxOp } from './bitrix';
import { canManageSession, listSessions } from './repo';
import { checkAvailability, hardConflictMessage } from './availability';
import { invalidateLive } from './live';
import { syncSessionCalendar } from './calendar';

interface Row { id: string; rop_bitrix_id: string; slot_start: Date; duration_min: number; held_at: Date | null }

export async function patchSession(
  session: SessionUser, scope: SessionScope, id: number, body: unknown,
): Promise<TaskerSessionPatchResponse> {
  const b = (body ?? {}) as Partial<TaskerSessionPatchRequest>;
  if (b.action !== 'done' && b.action !== 'undone' && b.action !== 'reschedule') throw new TaskerError('Неизвестное действие: done | undone | reschedule');
  const s = (await systemDb().query<Row>(
    `SELECT id, rop_bitrix_id, slot_start, duration_min, held_at FROM tasker_sessions WHERE id = $1`, [id])).rows[0];
  if (!s) throw new TaskerError('Сессия не найдена', 'forbidden', 404);
  const [settings, dir] = await Promise.all([loadSettings(), getEmployeeDirectory()]);
  if (!canManageSession(session, settings, dir, s.rop_bitrix_id)) {
    throw new TaskerError('Отмечать и переносить сессию может её исполнитель, его директор или админ', 'forbidden', 403);
  }
  const who = session.displayName || 'пользователь Монолитики';
  let availability: TaskerSessionPatchResponse['availability'] = null;
  let warning: string | null = null;

  if (b.action === 'done') {
    if (new Date(s.slot_start).getTime() > Date.now() + 15 * 60_000) throw new TaskerError('Сессия ещё не началась — отметить «Провёл» можно с её начала');
    await systemDb().query(`UPDATE tasker_sessions SET held_at = COALESCE(held_at, now()), held_by = COALESCE(held_by, $2), held_by_user = COALESCE(held_by_user, $3) WHERE id = $1`,
      [id, who, session.id]);
  } else if (b.action === 'undone') {
    await systemDb().query(`UPDATE tasker_sessions SET held_at = NULL, held_by = NULL, held_by_user = NULL WHERE id = $1`, [id]);
  } else {
    if (s.held_at) throw new TaskerError('Сессия уже отмечена проведённой — сначала снимите отметку');
    const start = new Date(String(b.slotStart ?? ''));
    if (!b.slotStart || Number.isNaN(start.getTime())) throw new TaskerError('Укажите новое время сессии');
    if (start.getTime() < Date.now() - 5 * 60_000) throw new TaskerError('Новое время — в прошлом');
    const dur = b.durationMin === undefined || b.durationMin === null ? s.duration_min : Math.round(Number(b.durationMin));
    if (!Number.isFinite(dur) || dur < 5 || dur > 480) throw new TaskerError('Длительность — от 5 минут до 8 часов');
    const startIso = start.toISOString();
    // Собрание 26.11, п.3: работа Задачника в это время у исполнителя или менеджеров сессии — отказ.
    const mgrs = (await systemDb().query<{ m: string }>(
      `SELECT DISTINCT manager_bitrix_id AS m FROM tasker_tasks WHERE session_id = $1 AND cancelled_at IS NULL`, [id])).rows.map(x => x.m);
    const busyMsg = await hardConflictMessage([{ id: s.rop_bitrix_id, role: 'Исполнитель' }, ...mgrs.map(m => ({ id: m, role: 'Менеджер' }))],
      [{ start: start.getTime(), end: start.getTime() + dur * 60_000 }], { sessionId: id });
    if (busyMsg) throw new TaskerError(`Время занято — перенос не сохранён. ${busyMsg}`, 'bad_request', 409);

    const client = await systemDb().connect();
    let tasks: { id: string; duration_min: number; bitrix_task_id: string | null; sync_state: string; manager_bitrix_id: string }[] = [];
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE tasker_sessions SET slot_start = $2, duration_min = $3 WHERE id = $1`, [id, startIso, dur]);
      tasks = (await client.query<typeof tasks[number]>(
        `UPDATE tasker_tasks SET slot_start = $2, slot_end = $2::timestamptz + make_interval(mins => duration_min), updated_at = now()
          WHERE session_id = $1 AND cancelled_at IS NULL
          RETURNING id, duration_min, bitrix_task_id, sync_state, manager_bitrix_id`, [id, startIso])).rows;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // Битрикс: плановые даты каждой задачи, затем одно событие сессии (в очереди последней задачи).
    const me = session.bitrixUserId ? String(session.bitrixUserId) : null;
    let lastErr: string | null = null;
    tasks.sort((a, c) => Number(a.id) - Number(c.id));
    for (const [i, t] of tasks.entries()) {
      const ops: BxOp[] = [];
      if (t.bitrix_task_id || t.sync_state === 'pending') {
        const end = new Date(start.getTime() + t.duration_min * 60_000).toISOString();
        ops.push({ op: 'update', fields: { START_DATE_PLAN: bxDate(startIso), END_DATE_PLAN: bxDate(end) }, asBitrixId: me });
      }
      if (i === tasks.length - 1) ops.push({ op: 'calendar', sessionId: id });
      if (!ops.length) continue;
      await enqueue(Number(t.id), ops);
      const res = await drainTask(Number(t.id), { force: true }).catch(e => ({ done: 0, error: e instanceof Error ? e.message : String(e) }));
      if (res.error) lastErr = res.error;
    }
    if (!tasks.length) await syncSessionCalendar(id).catch(e => { lastErr = e instanceof Error ? e.message : String(e); });
    if (lastErr) warning = `Перенос сохранён, но Битрикс пока не принял (${lastErr}) — повторим автоматически`;
    invalidateLive(settings.groupId);

    // Кто занят в новое время (исполнитель + менеджеры), без самой сессии.
    const people = [s.rop_bitrix_id, ...tasks.map(t => t.manager_bitrix_id)];
    const myId = session.bitrixUserId ? String(session.bitrixUserId) : null;
    availability = await checkAvailability(people, [{ start: start.getTime(), end: start.getTime() + dur * 60_000 }], { sessionId: id },
      pid => pid === myId || canSeeManager(scope, pid)).catch(() => null);
  }

  const [out] = await listSessions(session, { kind: 'all' }, { ids: [id] });
  if (!out) throw new TaskerError('Сессия не найдена', 'forbidden', 404);
  return { session: out, availability, warning };
}
