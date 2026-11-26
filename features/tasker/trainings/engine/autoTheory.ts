// Авторасписание «Теории» со своим временем (жалоба Будковского 26.11). Раньше такая задача висела в очереди тренера
// «один на один», и он руками собирал занятие. Теперь при создании задачи Монолитика сама ставит событие обучения
// у тренера на это время (тема = тема задачи, длительность = длительность задачи, создатель — РОП) и записывает
// туда менеджера. Есть у тренера неотменённое событие с тем же началом и той же темой — менеджер идёт в эту группу,
// пока есть места. Событие одно на тренера (его календарь — syncTrainingCalendar), своей сессии / task_calendar у
// задачи нет — дублей в календаре тренера не бывает. Закрытое время (299) и занятость тренера — отказ с причиной.
import 'server-only';
import type { PoolClient } from 'pg';
import { systemDb } from '@/lib/db/clients';
import { checkAvailability } from '../../engine/availability';
import { TaskerError } from '../../engine/config';
import { closureMessage, findClosure } from './closures';
import { DEFAULT_MEASURE_DAYS } from './effect';
import { groupMaxFor } from './slots';

export interface TheoryPlacement {
  eventId: number;
  startIso: string;
  endIso: string;
  /** true — присоединили к уже стоящей группе. */
  joined: boolean;
}

const fmt = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(11, 16);

async function findSameEvent(trainerId: string, startIso: string, metricId: string, db: Pick<PoolClient, 'query'> = systemDb()) {
  const r = await db.query<{ id: string; start_at: Date; duration_min: number; capacity: number | null; n: string }>(
    `SELECT e.id, e.start_at, e.duration_min, e.capacity,
            (SELECT count(*) FROM tasker_training_enrollments x WHERE x.event_id = e.id) AS n
       FROM tasker_training_events e
      WHERE e.trainer_bitrix_user_id = $1 AND e.start_at = $2 AND e.cancelled_at IS NULL AND $3 = ANY(e.metric_ids)
      ORDER BY e.id LIMIT 1`, [trainerId, startIso, metricId]);
  return r.rows[0] ?? null;
}

/**
 * Найти или поставить событие обучения для задач «Теория» со своим временем. Бросает TaskerError с понятным
 * текстом: время закрыто тренером, у тренера другое занятие/встреча, группа на это время уже набрана.
 */
export async function placeTheoryEvent(p: {
  trainerId: string; startIso: string; durationMin: number; metricId: string; metricLabel: string;
  managers: number; createdByUserId: string; creatorName: string;
}): Promise<TheoryPlacement> {
  const start = Date.parse(p.startIso);
  if (!Number.isFinite(start)) throw new TaskerError('Некорректное время занятия');
  if (start <= Date.now()) throw new TaskerError('Время занятия уже прошло — выберите будущее');
  const startIso = new Date(start).toISOString();
  const end = start + p.durationMin * 60_000;

  const closed = await findClosure(p.trainerId, start, end);
  if (closed) throw new TaskerError(closureMessage(closed), 'bad_request', 409);

  const fits = (ev: { capacity: number | null; n: string }) => ev.capacity == null || Number(ev.n) + p.managers <= ev.capacity;
  const full = (ev: { capacity: number | null; n: string }) => new TaskerError(
    `На ${fmt(start)} у тренера уже группа по «${p.metricLabel}»: занято ${ev.n} из ${ev.capacity} — выберите другое время`, 'bad_request', 409);

  const same = await findSameEvent(p.trainerId, startIso, p.metricId);
  if (same) {
    if (!fits(same)) throw full(same);
  } else {
    // Своё занятие — тренер должен быть свободен (Битрикс + Монолитика: обучения, сессии, задачи, собрания).
    const avail = await checkAvailability([p.trainerId], [{ start, end }], {}, () => true);
    const hit = avail.busy.find(x => String(x.id) === p.trainerId)?.conflicts ?? [];
    if (hit.length) {
      const what = [...new Set(hit.map(c => `${c.title} (${fmt(Date.parse(c.start))}–${fmt(Date.parse(c.end))})`))].slice(0, 3).join('; ');
      throw new TaskerError(`Тренер в это время занят: ${what} — выберите другое время`, 'bad_request', 409);
    }
  }

  // Найти-или-создать под advisory-lock: два РОПа на одно время и тему не наплодят два события.
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tasker-theory:${p.trainerId}:${startIso}`]);
    const again = await findSameEvent(p.trainerId, startIso, p.metricId, client);
    let out: TheoryPlacement;
    if (again) {
      if (!fits(again)) throw full(again);
      const st = again.start_at.getTime();
      out = { eventId: Number(again.id), startIso: new Date(st).toISOString(), endIso: new Date(st + again.duration_min * 60_000).toISOString(), joined: true };
    } else {
      const capacity = Math.max(await groupMaxFor([p.metricId]), p.managers);
      const r = await client.query<{ id: string }>(
        `INSERT INTO tasker_training_events (title, description, start_at, duration_min, place, capacity, trainer_bitrix_user_id, created_by,
                                             metric_ids, measure_before_days, measure_after_days)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $9) RETURNING id`,
        [p.metricLabel, `Занятие поставлено автоматически по задаче «Теория» (${p.creatorName}).`, startIso, p.durationMin,
          capacity, p.trainerId, p.createdByUserId, [p.metricId], DEFAULT_MEASURE_DAYS]);
      out = { eventId: Number(r.rows[0].id), startIso, endIso: new Date(end).toISOString(), joined: false };
    }
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
