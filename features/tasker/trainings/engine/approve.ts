// Занятие тренера (собрание 26.11, ТЗ tz/2026-11-26_tasker.md п.7):
//  - «Утвердить состав и тему» — тренер утром смотрит, кого записали РОПы и по какому поводу, правит тему
//    (название занятия) и утверждает: всем записанным уходит сообщение бота с темой и временем (managerNotify.ts);
//    отметка approved_at/approved_by (302). Повторное нажатие — повторная рассылка (например, после замены людей).
//  - «Повторить занятие» — тот же состав (или часть) на ту же тему в новое время без ручного перевбивания.
import 'server-only';
import { systemDb } from '@/lib/db/clients';
import type { TrainingEvent } from '../types';
import { createEvent, enroll, getEvent, TrainingError, type TrainingActor } from './index';
import { sendApprovedNotices } from '../../engine/managerNotify';

export async function approveEvent(actor: TrainingActor, id: number): Promise<{ event: TrainingEvent; sent: number }> {
  if (!actor.canManage) throw new TrainingError('Утверждает занятие тренер', 403);
  const cur = await systemDb().query<{ cancelled_at: Date | null; ended: boolean; n: string }>(
    `SELECT cancelled_at, (start_at + make_interval(mins => duration_min) <= now()) AS ended,
            (SELECT count(*) FROM tasker_training_enrollments x WHERE x.event_id = e.id) AS n
       FROM tasker_training_events e WHERE id = $1`, [id]);
  const e = cur.rows[0];
  if (!e) throw new TrainingError('Обучение не найдено', 404);
  if (e.cancelled_at) throw new TrainingError('Обучение отменено', 409);
  if (e.ended) throw new TrainingError('Обучение уже прошло', 409);
  if (!Number(e.n)) throw new TrainingError('Никто не записан — утверждать нечего', 409);
  await systemDb().query('UPDATE tasker_training_events SET approved_at = now(), approved_by = $2 WHERE id = $1',
    [id, actor.session.displayName || actor.session.login]).catch(err => {
    if ((err as { code?: string })?.code === '42703') throw new TrainingError('Утверждение заработает после миграции 302', 409);
    throw err;
  });
  const sent = await sendApprovedNotices(id);
  return { event: await getEvent(actor, id), sent };
}

export async function repeatEvent(actor: TrainingActor, id: number, raw: unknown): Promise<{ event: TrainingEvent; failed: { managerId: number; reason: string }[] }> {
  if (!actor.canManage) throw new TrainingError('Повторяет занятие тренер', 403);
  const b = (raw ?? {}) as { startsAt?: unknown; managerIds?: unknown };
  const src = await getEvent(actor, id);
  const start = Date.parse(String(b.startsAt ?? ''));
  if (!Number.isFinite(start)) throw new TrainingError('Укажите дату и время повтора');
  if (start <= Date.now()) throw new TrainingError('Время повтора уже прошло');
  const all = src.attendees.map(a => a.manager.id);
  const want = Array.isArray(b.managerIds) && b.managerIds.length ? new Set(b.managerIds.map(Number)) : new Set(all);
  const people = src.attendees.filter(a => want.has(a.manager.id));
  if (!people.length) throw new TrainingError('Выберите, кого позвать на повтор');
  const event = await createEvent(actor, {
    title: src.title, description: src.description, startsAt: new Date(start).toISOString(), durationMin: src.durationMin,
    place: src.place, capacity: src.capacity == null ? null : Math.max(src.capacity, people.length),
    trainerId: src.trainer?.id ?? null, metricIds: src.metricIds,
    measureBeforeDays: src.measureBeforeDays, measureAfterDays: src.measureAfterDays,
    slotId: null, departmentLabel: src.departmentLabel,
  });
  const failed: { managerId: number; reason: string }[] = [];
  for (const a of people) {
    try {
      await enroll(actor, event.id, a.manager.id, null, {
        goalMetricIds: a.goalMetricIds.length ? a.goalMetricIds : undefined,
        goalNote: `Повтор занятия «${src.title}»${a.goalNote ? `: ${a.goalNote}` : ''}`,
      });
    } catch (e) {
      failed.push({ managerId: a.manager.id, reason: e instanceof Error ? e.message : 'не удалось записать' });
    }
  }
  return { event: await getEvent(actor, event.id), failed };
}
