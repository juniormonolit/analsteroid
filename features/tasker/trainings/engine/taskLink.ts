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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  task_id: string; event_id: string; manager: string; creator_user_id: string | null;
  metric_id: string; snapshot: Snapshot | null; title: string;
}

export async function syncTaskEnrollments(limit = 50): Promise<number> {
  const db = systemDb();
  const r = await db.query<Row>(
    `SELECT t.id AS task_id, t.training_event_id AS event_id, t.manager_bitrix_id AS manager, t.creator_user_id,
            t.metric_id, t.snapshot, t.title
       FROM tasker_tasks t
      WHERE t.training_event_id IS NOT NULL AND t.cancelled_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tasker_training_enrollments x
                         WHERE x.event_id = t.training_event_id AND x.manager_bitrix_user_id = t.manager_bitrix_id
                           AND x.tasker_task_id IS NOT NULL)
        -- уже пробовали по этой задаче, или менеджера с этого обучения отписали руками — не записываем снова
        AND NOT EXISTS (SELECT 1 FROM tasker_training_enrollment_log l
                         WHERE (l.tasker_task_id = t.id AND l.action IN ('enroll', 'enroll_failed'))
                            OR (l.event_id = t.training_event_id AND l.manager_bitrix_user_id = t.manager_bitrix_id
                                AND l.action = 'unenroll' AND l.created_at > t.created_at))
      ORDER BY t.id LIMIT $1`,
    [limit],
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

let lastAt = 0;
/** Перед чтением расписания: не чаще раза в 20 с на инстанс; таблиц ядра ещё нет — молча. */
export async function syncTaskEnrollmentsThrottled(): Promise<void> {
  if (Date.now() - lastAt < 20_000) return;
  lastAt = Date.now();
  await syncTaskEnrollments(20).catch(err => {
    if ((err as { code?: string })?.code !== '42P01') console.error('[tasker/trainings task-link]', err instanceof Error ? err.message : err);
  });
}
