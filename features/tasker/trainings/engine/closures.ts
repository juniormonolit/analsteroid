// Закрытое время тренера (миграция 299, жалоба Будковского 26.11): день целиком (или несколько дней) либо интервал
// внутри дня, когда записывать к тренеру нельзя. Правит тренер (canManage) во «Обучения → Настройки» и в сетке недели.
// Проверяют: форма/создание задачи «Теория» (своё время и групповое занятие), запись на занятие (enroll), подсказка
// слота (suggest) и «Собрать занятие» (assemble). До наката 299 таблицы нет — «ничего не закрыто», раздел работает.
import 'server-only';
import { systemDb } from '@/lib/db/clients';
import type { TrainingClosure, TrainingClosureInput, TrainingClosuresResponse } from '../types';
import { TrainingError, type TrainingActor } from './index';
import { defaultTrainerId } from './slots';

interface Row { id: string; trainer_bitrix_user_id: string; starts_at: Date; ends_at: Date; all_day: boolean; reason: string | null }

const missing = (e: unknown) => (e as { code?: string })?.code === '42P01';

const toClosure = (r: Row): TrainingClosure => ({
  id: Number(r.id), trainerId: Number(r.trainer_bitrix_user_id), startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString(),
  allDay: r.all_day, reason: r.reason,
});

/** Закрытия тренера, пересекающие [fromMs, toMs). */
export async function closuresBetween(trainerId: string, fromMs: number, toMs: number): Promise<TrainingClosure[]> {
  const r = await systemDb().query<Row>(
    `SELECT id, trainer_bitrix_user_id, starts_at, ends_at, all_day, reason FROM tasker_training_closures
      WHERE trainer_bitrix_user_id = $1 AND starts_at < $3 AND ends_at > $2 ORDER BY starts_at`,
    [trainerId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  ).catch(e => { if (missing(e)) return { rows: [] as Row[] }; throw e; });
  return r.rows.map(toClosure);
}

/** Первое закрытие, пересекающее интервал, или null. */
export async function findClosure(trainerId: string, startMs: number, endMs: number): Promise<TrainingClosure | null> {
  return (await closuresBetween(trainerId, startMs, endMs))[0] ?? null;
}

const fmtDay = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 10).split('-').reverse().slice(0, 2).join('.');
const fmtTime = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(11, 16);

/** «27.11 (весь день)», «27.11–29.11», «27.11 с 14:00 до 16:00» — по Москве. */
export function closureWhen(c: TrainingClosure): string {
  const s = Date.parse(c.startsAt);
  const e = Date.parse(c.endsAt);
  if (c.allDay) {
    const last = e - 86_400_000;
    return fmtDay(s) === fmtDay(last) ? `${fmtDay(s)} (весь день)` : `${fmtDay(s)}–${fmtDay(last)}`;
  }
  return `${fmtDay(s)} с ${fmtTime(s)} до ${fmtTime(e)}`;
}

/** Текст отказа для форм и API. */
export function closureMessage(c: TrainingClosure): string {
  return `Тренер закрыл запись на ${closureWhen(c)}${c.reason ? `: ${c.reason}` : ''} — выберите другое время`;
}

export async function listClosures(actor: TrainingActor, from: string | null, to: string | null): Promise<TrainingClosuresResponse> {
  const trainer = await defaultTrainerId();
  const fromMs = from ? Date.parse(`${from}T00:00:00+03:00`) : Date.now() - 86_400_000;
  const toMs = to ? Date.parse(`${to}T00:00:00+03:00`) + 86_400_000 : fromMs + 120 * 86_400_000;
  return { closures: await closuresBetween(trainer, fromMs, toMs), canManage: actor.canManage };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export async function createClosure(actor: TrainingActor, raw: unknown): Promise<TrainingClosure> {
  if (!actor.canManage) throw new TrainingError('Закрывать запись может только тренер', 403);
  const b = (raw ?? {}) as Partial<Record<keyof TrainingClosureInput, unknown>>;
  const date = String(b.date ?? '');
  if (!YMD.test(date)) throw new TrainingError('Укажите дату');
  const dateTo = b.dateTo ? String(b.dateTo) : date;
  if (!YMD.test(dateTo) || dateTo < date) throw new TrainingError('«По какую дату» — не раньше начальной');
  const tf = b.timeFrom ? String(b.timeFrom) : '';
  const tt = b.timeTo ? String(b.timeTo) : '';
  const reason = b.reason == null ? null : String(b.reason).trim().slice(0, 200) || null;
  let start: number; let end: number; let allDay: boolean;
  if (!tf && !tt) {
    allDay = true;
    start = Date.parse(`${date}T00:00:00+03:00`);
    end = Date.parse(`${dateTo}T00:00:00+03:00`) + 86_400_000;
    if ((end - start) / 86_400_000 > 62) throw new TrainingError('Не больше двух месяцев за раз');
  } else {
    if (!HM.test(tf) || !HM.test(tt)) throw new TrainingError('Время «с» и «по» — в формате ЧЧ:ММ (или оба пусто — весь день)');
    if (dateTo !== date) throw new TrainingError('Интервал по времени — в пределах одного дня');
    allDay = false;
    start = Date.parse(`${date}T${tf}:00+03:00`);
    end = Date.parse(`${date}T${tt}:00+03:00`);
    if (end <= start) throw new TrainingError('«По» должно быть позже «с»');
  }
  if (end <= Date.now()) throw new TrainingError('Это время уже прошло');
  const trainer = await defaultTrainerId();
  const r = await systemDb().query<Row>(
    `INSERT INTO tasker_training_closures (trainer_bitrix_user_id, starts_at, ends_at, all_day, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, trainer_bitrix_user_id, starts_at, ends_at, all_day, reason`,
    [trainer, new Date(start).toISOString(), new Date(end).toISOString(), allDay, reason, actor.session.id],
  ).catch(e => { if (missing(e)) throw new TrainingError('Закрытие записи ещё не развёрнуто: не применена миграция 299', 503); throw e; });
  return toClosure(r.rows[0]);
}

export async function deleteClosure(actor: TrainingActor, id: number): Promise<void> {
  if (!actor.canManage) throw new TrainingError('Открывать запись может только тренер', 403);
  const r = await systemDb().query('DELETE FROM tasker_training_closures WHERE id = $1', [id]);
  if (!r.rowCount) throw new TrainingError('Закрытие не найдено', 404);
}
