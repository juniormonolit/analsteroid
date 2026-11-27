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
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { closureMessage, closuresBetween, findClosure } from './closures';
import { DEFAULT_MEASURE_DAYS } from './effect';
import { groupMaxFor, groupSettings, loadSlots } from './slots';

/** Начало описания автособытия — по нему (и создателю ≠ тренер) отмена задачи гасит опустевшее событие (taskLink.ts). */
export const AUTO_EVENT_NOTE = 'Занятие поставлено автоматически по задаче «Теория»';

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
        [p.metricLabel, `${AUTO_EVENT_NOTE} (${p.creatorName}).`, startIso, p.durationMin,
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

// ── «Теория» без времени → ближайший слот отдела (собрание 26.11, ТЗ tz/2026-11-26_tasker.md п.7) ──────────
// Тренер: слоты фиксированы по отделам (Москва — вт/чт 16:15, СПб — каждый будний день), РОП сегодня записывает
// людей на завтра. Поэтому задача «Теория» без своего времени сразу ставит менеджера в ближайший слот сетки
// тренера, закреплённый за его отделом (или общий), — не раньше следующего дня, тренер свободен, в группе есть
// место. Тема занятия — повод (метрика); что провести, решает тренер (правит название занятия). На это время уже
// стоит занятие тренера (любой темы) — менеджер идёт в эту группу, метрика добавляется к поводам занятия.
// Минимум «3 человека в очереди» не ждём. Не нашлось — null: задача остаётся в очереди тренера, как раньше.

const ymdOf = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 10);
const plusDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekdayOf = (ymd: string) => { const d = new Date(`${ymd}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };

export async function autoPlaceTheory(p: {
  trainerId: string; managerId: string; metricId: string; metricLabel: string; createdByUserId: string; creatorName: string;
}): Promise<TheoryPlacement | null> {
  const [slots, group] = await Promise.all([loadSlots(p.trainerId), groupSettings()]);
  // Слот «из Excel» без выбранных отделов (только подпись) автоматически не берём — как в подсказке очереди.
  const usable = slots.filter(s => s.active && !(s.departmentIds.length === 0 && !!s.departmentLabel));
  const eligible: typeof usable = [];
  for (const s of usable) {
    if (s.departmentIds.length) {
      const inDept = new Set((await resolveManagersForDepartments(s.departmentIds)).map(m => String(m.managerId)));
      if (!inDept.has(p.managerId)) continue;
    }
    eligible.push(s);
  }
  if (!eligible.length) return null;

  const tomorrow = plusDays(ymdOf(Date.now()), 1);
  const cands: { slot: (typeof eligible)[number]; start: number; end: number }[] = [];
  for (let d = 0; d < group.horizonDays && cands.length < 60; d++) {
    const ymd = plusDays(tomorrow, d);
    const wd = weekdayOf(ymd);
    for (const s of eligible) {
      if (s.weekday !== wd) continue;
      const start = Date.parse(`${ymd}T${s.startTime}:00+03:00`);
      cands.push({ slot: s, start, end: start + s.durationMin * 60_000 });
    }
  }
  cands.sort((a, b) => a.start - b.start);
  if (!cands.length) return null;

  const closed = await closuresBetween(p.trainerId, cands[0].start, cands[cands.length - 1].end);
  const open = cands.filter(c => !closed.some(x => Date.parse(x.startsAt) < c.end && c.start < Date.parse(x.endsAt)));
  if (!open.length) return null;

  // Уже стоящие занятия тренера в эти слоты (любая тема).
  const evs = await systemDb().query<{ id: string; start_at: Date; duration_min: number; capacity: number | null; n: string; has_me: boolean; metric_ids: string[] }>(
    `SELECT e.id, e.start_at, e.duration_min, e.capacity, e.metric_ids,
            (SELECT count(*) FROM tasker_training_enrollments x WHERE x.event_id = e.id) AS n,
            EXISTS (SELECT 1 FROM tasker_training_enrollments x WHERE x.event_id = e.id AND x.manager_bitrix_user_id = $4) AS has_me
       FROM tasker_training_events e
      WHERE e.trainer_bitrix_user_id = $1 AND e.cancelled_at IS NULL AND e.start_at = ANY($2::timestamptz[])
        AND e.start_at <= $3`,
    [p.trainerId, open.map(c => new Date(c.start).toISOString()), new Date(open[open.length - 1].end).toISOString(), p.managerId]);
  const evAt = new Map(evs.rows.map(e => [e.start_at.getTime(), e]));

  // Занятость: тренер — Битрикс + Монолитика (как у своего времени РОПа), менеджер — только работа Задачника.
  const avail = await checkAvailability([p.trainerId, p.managerId], open.map(c => ({ start: c.start, end: c.end })), {}, () => true);
  const conflictsOf = (who: string, idx: number) => (avail.busy.find(x => String(x.id) === who)?.conflicts ?? []).filter(c => c.slotIndex === idx);

  for (const [idx, c] of open.entries()) {
    const ev = evAt.get(c.start);
    if (ev) {
      if (ev.has_me) continue;
      if (ev.capacity != null && Number(ev.n) + 1 > ev.capacity) continue;
    }
    // Своё же занятие в этом слоте занятостью не считается.
    const selfTitle = (t: string) => ev && t.startsWith('Обучение · ');
    const trainerHits = conflictsOf(p.trainerId, idx).filter(x => !(ev && x.source === 'training' && selfTitle(x.title)));
    if (!ev && trainerHits.length) continue;
    if (ev && trainerHits.some(x => x.source !== 'bitrix' && x.source !== 'training')) continue;
    const managerHits = conflictsOf(p.managerId, idx).filter(x => x.source === 'task' || x.source === 'session' || x.source === 'training');
    if (managerHits.length) continue;

    const startIso = new Date(c.start).toISOString();
    const client = await systemDb().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tasker-theory:${p.trainerId}:${startIso}`]);
      const again = await client.query<{ id: string; duration_min: number; capacity: number | null; n: string; metric_ids: string[] }>(
        `SELECT e.id, e.duration_min, e.capacity, e.metric_ids, (SELECT count(*) FROM tasker_training_enrollments x WHERE x.event_id = e.id) AS n
           FROM tasker_training_events e
          WHERE e.trainer_bitrix_user_id = $1 AND e.start_at = $2 AND e.cancelled_at IS NULL ORDER BY e.id LIMIT 1 FOR UPDATE`,
        [p.trainerId, startIso]);
      const cur = again.rows[0];
      let out: TheoryPlacement | null = null;
      if (cur) {
        if (cur.capacity == null || Number(cur.n) + 1 <= cur.capacity) {
          if (!(cur.metric_ids ?? []).includes(p.metricId)) {
            await client.query('UPDATE tasker_training_events SET metric_ids = array_append(metric_ids, $2), updated_at = now() WHERE id = $1', [cur.id, p.metricId]);
          }
          out = { eventId: Number(cur.id), startIso, endIso: new Date(c.start + cur.duration_min * 60_000).toISOString(), joined: true };
        }
      } else {
        const capacity = await groupMaxFor([p.metricId], group);
        const r = await client.query<{ id: string }>(
          `INSERT INTO tasker_training_events (title, description, start_at, duration_min, place, capacity, trainer_bitrix_user_id, created_by,
                                               metric_ids, measure_before_days, measure_after_days)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
          [p.metricLabel, `${AUTO_EVENT_NOTE} (${p.creatorName}), слот отдела.`, startIso, c.slot.durationMin, c.slot.place,
            capacity, p.trainerId, p.createdByUserId, [p.metricId], DEFAULT_MEASURE_DAYS]);
        // Колонки 281 — отдельно: без них авторасписание всё равно работает.
        await client.query('SAVEPOINT s281');
        await client.query('UPDATE tasker_training_events SET slot_id = $2, department_label = $3 WHERE id = $1', [r.rows[0].id, c.slot.id, c.slot.departmentLabel])
          .then(() => client.query('RELEASE SAVEPOINT s281'))
          .catch(() => client.query('ROLLBACK TO SAVEPOINT s281'));
        out = { eventId: Number(r.rows[0].id), startIso, endIso: new Date(c.end).toISOString(), joined: false };
      }
      await client.query('COMMIT');
      if (out) return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return null;
}
