// Сетка тренера (миграция 281): недельные слоты «день × время», закреплённые отделы, размер группы.
// Правит тренер (action.tasker.trainings.manage) на вкладке «Настройки» раздела обучений — не хардкод.
import 'server-only';
import { systemDb } from '@/lib/db/clients';
import { resolveEmployeeNames } from '@/lib/org/employeeDirectory';
import { getSalesDepartmentOptions } from '@/lib/org/teamRoster';
import type { TrainingGroupSettings, TrainingSlot, TrainingSlotInput, TrainingSlotsResponse } from '../types';
import { TrainingError, type TrainingActor } from './index';

/** Тренер по умолчанию — tasker_settings 'trainer' (ведёт сессия A), иначе Будковский (2054). */
export const DEFAULT_TRAINER_ID = '2054';
export const DEFAULT_GROUP: TrainingGroupSettings = { min: 3, target: 4, max: 5, horizonDays: 14 };

const ignoreMissing = <T,>(fallback: T) => (e: unknown): T => {
  const code = (e as { code?: string })?.code;
  if (code === '42P01' || code === '42703') return fallback;
  throw e;
};

async function setting(key: string): Promise<unknown> {
  const r = await systemDb().query<{ value: unknown }>('SELECT value FROM tasker_settings WHERE key = $1', [key])
    .catch(ignoreMissing({ rows: [] as { value: unknown }[] }));
  return r.rows[0]?.value ?? null;
}

export async function defaultTrainerId(): Promise<string> {
  const v = await setting('trainer');
  const raw = typeof v === 'object' && v !== null && 'id' in v ? (v as { id: unknown }).id : v;
  const s = raw == null ? '' : String(raw).trim();
  return /^\d+$/.test(s) ? s : DEFAULT_TRAINER_ID;
}

export async function groupSettings(): Promise<TrainingGroupSettings> {
  const v = (await setting('training_group')) as Record<string, unknown> | null;
  const num = (x: unknown, d: number) => (Number.isInteger(Number(x)) && Number(x) > 0 ? Number(x) : d);
  const min = num(v?.min, DEFAULT_GROUP.min);
  const max = Math.max(min, num(v?.max, DEFAULT_GROUP.max));
  const target = Math.min(max, Math.max(min, num(v?.target, DEFAULT_GROUP.target)));
  return { min, target, max, horizonDays: Math.min(60, num(v?.horizon_days, DEFAULT_GROUP.horizonDays)) };
}

interface SlotRow {
  id: string; trainer_bitrix_user_id: string | null; weekday: number; start_time: string; duration_min: number;
  label: string | null; place: string | null; is_offline: boolean; department_ids: string[]; department_label: string | null; active: boolean;
}

const toSlot = (r: SlotRow): TrainingSlot => ({
  id: Number(r.id), trainerId: r.trainer_bitrix_user_id ? Number(r.trainer_bitrix_user_id) : null, weekday: r.weekday,
  startTime: r.start_time.slice(0, 5), durationMin: r.duration_min, label: r.label, place: r.place, isOffline: r.is_offline,
  departmentIds: r.department_ids ?? [], departmentLabel: r.department_label, active: r.active,
});

/** Слоты тренера (свои + общие с trainer NULL, если тренер — дефолтный). */
export async function loadSlots(trainerId?: string | null): Promise<TrainingSlot[]> {
  const def = await defaultTrainerId();
  const who = trainerId ?? def;
  const r = await systemDb().query<SlotRow>(
    `SELECT id, trainer_bitrix_user_id, weekday, start_time::text AS start_time, duration_min, label, place, is_offline,
            department_ids, department_label, active
       FROM tasker_training_slots
      WHERE trainer_bitrix_user_id = $1 OR (trainer_bitrix_user_id IS NULL AND $1 = $2)
      ORDER BY weekday, start_time`, [who, def],
  ).catch(ignoreMissing({ rows: [] as SlotRow[] }));
  return r.rows.map(toSlot);
}

export async function slotsResponse(actor: TrainingActor): Promise<TrainingSlotsResponse> {
  const trainerId = await defaultTrainerId();
  const [slots, group, departments, names] = await Promise.all([
    loadSlots(trainerId), groupSettings(),
    actor.canManage ? getSalesDepartmentOptions().catch(() => []) : Promise.resolve([]),
    resolveEmployeeNames([Number(trainerId)]),
  ]);
  return {
    slots, group, canManage: actor.canManage,
    trainer: { id: Number(trainerId), name: names.get(Number(trainerId)) ?? `Сотрудник #${trainerId}` },
    departments: departments.map(d => ({ id: d.id, name: d.name, path: d.path ?? null })),
  };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function cleanSlot(raw: unknown, i: number): TrainingSlotInput {
  const b = (raw ?? {}) as Record<string, unknown>;
  const where = `Слот ${i + 1}`;
  const weekday = Number(b.weekday);
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new TrainingError(`${where}: день недели`);
  const startTime = String(b.startTime ?? '').trim();
  if (!TIME_RE.test(startTime)) throw new TrainingError(`${where}: время в формате ЧЧ:ММ`);
  const durationMin = Number(b.durationMin);
  if (!Number.isInteger(durationMin) || durationMin < 10 || durationMin > 240) throw new TrainingError(`${where}: длительность 10–240 мин`);
  const text = (x: unknown, max: number) => { const s = x == null ? '' : String(x).trim(); return s ? s.slice(0, max) : null; };
  const ids = Array.isArray(b.departmentIds) ? [...new Set(b.departmentIds.map(String).filter(s => /^[0-9a-f-]{8,}$/i.test(s)))].slice(0, 30) : [];
  const id = Number(b.id);
  return {
    id: Number.isInteger(id) && id > 0 ? id : null, weekday, startTime, durationMin,
    label: text(b.label, 80), place: text(b.place, 300), isOffline: !!b.isOffline,
    departmentIds: ids, departmentLabel: text(b.departmentLabel, 80), active: b.active !== false,
  };
}

/**
 * Сохранение сетки целиком (как таблица в Excel): переданные слоты — upsert по id, остальные слоты этого тренера
 * удаляются (события, собранные из них, остаются: slot_id → NULL).
 */
export async function saveSlots(actor: TrainingActor, raw: unknown): Promise<TrainingSlotsResponse> {
  if (!actor.canManage) throw new TrainingError('Сетку слотов ведёт тренер', 403);
  const b = (raw ?? {}) as { slots?: unknown; group?: Record<string, unknown> };
  if (!Array.isArray(b.slots) || b.slots.length > 100) throw new TrainingError('Нужен список слотов (до 100)');
  const slots = b.slots.map(cleanSlot);
  const dup = new Set<string>();
  for (const s of slots) {
    const k = `${s.weekday}|${s.startTime}`;
    if (dup.has(k)) throw new TrainingError(`Два слота в одно время: ${['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][s.weekday]} ${s.startTime}`);
    dup.add(k);
  }
  const trainerId = await defaultTrainerId();
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    const keep = slots.map(s => s.id).filter((x): x is number => x !== null);
    await client.query(
      `DELETE FROM tasker_training_slots
        WHERE (trainer_bitrix_user_id = $1 OR trainer_bitrix_user_id IS NULL) AND NOT (id = ANY($2::bigint[]))`, [trainerId, keep]);
    // Сначала уводим время у сохраняемых в сторону, чтобы перестановка «9:30 ↔ 10:15» не упёрлась в уникальный индекс.
    if (keep.length) await client.query(`UPDATE tasker_training_slots SET start_time = '00:00'::time + make_interval(secs => id % 3000) WHERE id = ANY($1::bigint[])`, [keep]);
    for (const s of slots) {
      const vals = [s.weekday, s.startTime, s.durationMin, s.label, s.place, s.isOffline, s.departmentIds, s.departmentLabel, s.active];
      if (s.id) {
        await client.query(
          `UPDATE tasker_training_slots SET weekday = $2, start_time = $3::time, duration_min = $4, label = $5, place = $6, is_offline = $7,
                  department_ids = $8, department_label = $9, active = $10, updated_at = now()
            WHERE id = $1`, [s.id, ...vals]);
      } else {
        await client.query(
          `INSERT INTO tasker_training_slots (weekday, start_time, duration_min, label, place, is_offline, department_ids, department_label, active)
           VALUES ($1, $2::time, $3, $4, $5, $6, $7, $8, $9)`, vals);
      }
    }
    if (b.group) {
      const g = b.group;
      const n = (x: unknown, lo: number, hi: number, what: string) => {
        const v = Number(x);
        if (!Number.isInteger(v) || v < lo || v > hi) throw new TrainingError(`${what}: от ${lo} до ${hi}`);
        return v;
      };
      const min = n(g.min, 1, 30, 'Минимум в группе');
      const max = n(g.max, min, 50, 'Максимум в группе');
      const target = n(g.target ?? max, min, max, 'Обычный размер группы');
      const horizon = n(g.horizonDays ?? DEFAULT_GROUP.horizonDays, 1, 60, 'Искать слот вперёд, дней');
      await client.query(
        `INSERT INTO tasker_settings (key, value, updated_at) VALUES ('training_group', $1::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify({ min, target, max, horizon_days: horizon })]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return slotsResponse(actor);
}
