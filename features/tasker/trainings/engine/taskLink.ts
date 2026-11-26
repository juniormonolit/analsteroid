// «Записать на обучение» из формы задачи (сессия C → ядро A пишет tasker_tasks.training_event_id, но саму запись
// не делает). Досинхронизация здесь: задача с training_event_id и без записи её менеджера на это событие →
// запись (enrolled_by — постановщик, цель — показатель и снимок задачи). Если записать нельзя (отменено, прошло,
// нет мест) — одна строка enroll_failed в журнале на задачу, без повторов.
// Вызывается в тике фоновой задачи tasker и (с троттлингом) перед чтением расписания.
import 'server-only';
import { systemDb } from '@/lib/db/clients';
import type { Snapshot } from '../../types';
import { syncTrainingCalendar } from './calendar';
import { writeLog } from './results';
import { AUTO_EVENT_NOTE } from './autoTheory';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  task_id: string; event_id: string; manager: string; creator_user_id: string | null;
  metric_id: string; snapshot: Snapshot | null; title: string;
}

/** taskIds — только эти задачи (сразу после создания «Теории» со своим временем, create.ts). */
export async function syncTaskEnrollments(limit = 50, taskIds?: number[]): Promise<number> {
  const db = systemDb();
  const r = await db.query<Row>(
    `SELECT t.id AS task_id, t.training_event_id AS event_id, t.manager_bitrix_id AS manager, t.creator_user_id,
            t.metric_id, t.snapshot, t.title
       FROM tasker_tasks t
      WHERE t.training_event_id IS NOT NULL AND t.cancelled_at IS NULL
        AND ($2::bigint[] IS NULL OR t.id = ANY($2::bigint[]))
        AND NOT EXISTS (SELECT 1 FROM tasker_training_enrollments x
                         WHERE x.event_id = t.training_event_id AND x.manager_bitrix_user_id = t.manager_bitrix_id
                           AND x.tasker_task_id IS NOT NULL)
        -- уже пробовали по этой задаче, или менеджера с этого обучения отписали руками — не записываем снова
        AND NOT EXISTS (SELECT 1 FROM tasker_training_enrollment_log l
                         WHERE (l.tasker_task_id = t.id AND l.action IN ('enroll', 'enroll_failed'))
                            OR (l.event_id = t.training_event_id AND l.manager_bitrix_user_id = t.manager_bitrix_id
                                AND l.action = 'unenroll' AND l.created_at > t.created_at))
      ORDER BY t.id LIMIT $1`,
    [limit, taskIds?.length ? taskIds : null],
  );
  let done = 0;
  const touched = new Set<number>();
  for (const t of r.rows) {
    const eventId = Number(t.event_id);
    const taskId = Number(t.task_id);
    const actor = t.creator_user_id && UUID_RE.test(t.creator_user_id) ? t.creator_user_id : null;
    const snapshot = t.snapshot && Object.keys(t.snapshot).length ? JSON.stringify(t.snapshot) : null;
    const client = await db.connect();
    let result: 'enrolled' | 'linked' | string = '';
    try {
      await client.query('BEGIN');
      const ev = await client.query<{ capacity: number | null; cancelled_at: Date | null; ended: boolean; metric_ids: string[] }>(
        `SELECT capacity, cancelled_at, (start_at + make_interval(mins => duration_min) <= now()) AS ended, metric_ids
           FROM tasker_training_events WHERE id = $1 FOR UPDATE`, [eventId]);
      const e = ev.rows[0];
      const existing = await client.query('SELECT 1 FROM tasker_training_enrollments WHERE event_id = $1 AND manager_bitrix_user_id = $2', [eventId, t.manager]);
      if (!e) result = 'обучение не найдено';
      else if (existing.rowCount) {
        // Уже записан вручную — привязываем задачу и её показатель к записи.
        await client.query(
          `UPDATE tasker_training_enrollments
              SET tasker_task_id = $3, task_metric_id = $4, task_snapshot = COALESCE(task_snapshot, $5::jsonb),
                  goal_metric_ids = CASE WHEN $4 = ANY(goal_metric_ids) THEN goal_metric_ids ELSE goal_metric_ids || $4 END,
                  goal_note = COALESCE(goal_note, $6)
            WHERE event_id = $1 AND manager_bitrix_user_id = $2`,
          [eventId, t.manager, taskId, t.metric_id, snapshot, `Задача: ${t.title}`]);
        result = 'linked';
      } else if (e.cancelled_at) result = 'обучение отменено';
      else if (e.ended) result = 'обучение уже прошло';
      else {
        const c = e.capacity == null ? null : Number((await client.query<{ n: string }>('SELECT count(*) AS n FROM tasker_training_enrollments WHERE event_id = $1', [eventId])).rows[0].n);
        if (c !== null && e.capacity !== null && c >= e.capacity) result = 'мест больше нет';
        else {
          const goals = [...new Set([...(e.metric_ids ?? []), t.metric_id])];
          await client.query(
            `INSERT INTO tasker_training_enrollments
               (event_id, manager_bitrix_user_id, enrolled_by, tasker_task_id, goal_metric_ids, goal_note, task_metric_id, task_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
            [eventId, t.manager, actor, taskId, goals, `Задача: ${t.title}`, t.metric_id, snapshot]);
          await client.query(`UPDATE tasker_training_events SET calendar_sync_state = 'pending' WHERE id = $1`, [eventId]);
          result = 'enrolled';
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[tasker/trainings task-link]', taskId, err instanceof Error ? err.message : err);
      continue;
    } finally {
      client.release();
    }
    if (result === 'enrolled' || result === 'linked') {
      done++;
      await writeLog(db, { eventId, managerId: t.manager, action: result === 'enrolled' ? 'enroll' : 'goal', actorUserId: actor, taskId,
        details: { fromTask: true, goalMetricIds: [t.metric_id], goalNote: `Задача: ${t.title}` } });
      if (result === 'enrolled') touched.add(eventId);
    } else {
      await writeLog(db, { eventId, managerId: t.manager, action: 'enroll_failed', actorUserId: actor, taskId, details: { reason: result } });
    }
  }
  for (const id of touched) await syncTrainingCalendar(id);
  return done;
}

/**
 * Отменённая задача (tasker_tasks.cancelled_at или «отклонена» в Битриксе, статус 7) → её менеджер снимается с
 * будущего занятия, на которое его записала задача (как unenroll: журнал, замеры, задача отвязывается, календарь).
 * Опустевшее автособытие «Теории» (поставлено по задаче РОПа, не тренером вручную) отменяется — и в календаре тренера.
 * Прошедшие занятия не трогаем: там посещаемость и замеры.
 */
export async function releaseCancelledTasks(limit = 50): Promise<number> {
  const db = systemDb();
  const r = await db.query<{ event_id: string; manager: string; task_id: string }>(
    `SELECT x.event_id, x.manager_bitrix_user_id AS manager, t.id AS task_id
       FROM tasker_training_enrollments x
       JOIN tasker_tasks t ON t.id = x.tasker_task_id
       JOIN tasker_training_events e ON e.id = x.event_id
      WHERE (t.cancelled_at IS NOT NULL OR t.bitrix_status = 7)
        AND e.cancelled_at IS NULL AND e.start_at + make_interval(mins => e.duration_min) > now()
      ORDER BY x.event_id LIMIT $1`, [limit]);
  const touched = new Set<number>();
  for (const x of r.rows) {
    const eventId = Number(x.event_id);
    const taskId = Number(x.task_id);
    const del = await db.query('DELETE FROM tasker_training_enrollments WHERE event_id = $1 AND manager_bitrix_user_id = $2 AND tasker_task_id = $3',
      [eventId, x.manager, taskId]);
    if (!del.rowCount) continue;
    await writeLog(db, { eventId, managerId: x.manager, action: 'unenroll', actorUserId: null, taskId, details: { reason: 'task_cancelled' } });
    await db.query('DELETE FROM tasker_training_results WHERE event_id = $1 AND manager_bitrix_user_id = $2', [eventId, x.manager]);
    await db.query('UPDATE tasker_tasks SET training_event_id = NULL, updated_at = now() WHERE id = $1 AND training_event_id = $2', [taskId, eventId]);
    await db.query(`UPDATE tasker_training_events SET calendar_sync_state = 'pending' WHERE id = $1`, [eventId]);
    touched.add(eventId);
  }
  if (!touched.size) return 0;
  // Пустое автособытие: описание начинается с метки авторасписания и создатель — не сам тренер.
  const empty = await db.query<{ id: string }>(
    `UPDATE tasker_training_events e
        SET cancelled_at = now(), calendar_sync_state = 'pending', updated_at = now()
       FROM users u
      WHERE e.id = ANY($1::bigint[]) AND e.cancelled_at IS NULL
        AND u.id = e.created_by AND COALESCE(u.bitrix_user_id::text, '') <> COALESCE(e.trainer_bitrix_user_id, '')
        AND e.description LIKE $2 || '%'
        AND NOT EXISTS (SELECT 1 FROM tasker_training_enrollments x WHERE x.event_id = e.id)
      RETURNING e.id`, [[...touched], AUTO_EVENT_NOTE]);
  if (empty.rows.length) console.info('[tasker/trainings] отменены опустевшие автособытия:', empty.rows.map(x => x.id).join(', '));
  for (const id of touched) await syncTrainingCalendar(id); // участники / удаление события из календаря тренера
  return r.rows.length;
}

let lastAt = 0;
/** Перед чтением расписания: не чаще раза в 20 с на инстанс; таблиц ядра ещё нет — молча. */
export async function syncTaskEnrollmentsThrottled(): Promise<void> {
  if (Date.now() - lastAt < 20_000) return;
  lastAt = Date.now();
  await releaseCancelledTasks(20).catch(err => {
    if ((err as { code?: string })?.code !== '42P01') console.error('[tasker/trainings task-cancel]', err instanceof Error ? err.message : err);
  });
  await syncTaskEnrollments(20).catch(err => {
    if ((err as { code?: string })?.code !== '42P01') console.error('[tasker/trainings task-link]', err instanceof Error ? err.message : err);
  });
}
