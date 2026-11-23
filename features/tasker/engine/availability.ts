// Проверка наложения времени при планировании (TASKER_SPEC.md «Расписание: проверка занятости»).
// Предупреждение, не запрет: формы показывают «в это время заняты 3 из 8» и всё равно дают сохранить.
//
// Источники занятости человека:
//  - календарь Битрикса — calendar.accessibility.get (одним вызовом на пачку людей, кэш 150 с);
//  - события Монолитики — сессии РОПа, обучения (сессия D), вхождения регулярных собраний, слоты задач.
// События, которые Монолитика сама поставила в Битрикс, приходят и оттуда — их копии отбрасываем по точному
// совпадению интервала с событием Монолитики того же человека (у каждого участника своя копия со своим ID).
// Свои события при правке (exclude) не конфликтуют сами с собой: исключаем их из Монолитики, а их копии в
// Битриксе отбрасываются тем же сравнением (сравниваем с полным списком, до исключения).
// Битрикс не ответил — считаем только по Монолитике, bitrixChecked=false (форма пишет «календарь не проверен»).
import { systemDb } from '@/lib/db/clients';
import { bx } from '@/lib/bitrix/notify';
import { cached } from '@/lib/cache/redis';
import { getEmployeeDirectory } from '@/lib/org/employeeDirectory';
import { taskWebhook } from '@/features/repeat-kanban/engine/createDeal';
import type { TaskerAvailabilityPerson, TaskerAvailabilityResponse, TaskerBusyInterval, TaskerBusySource } from '../types';
import { loadMetricDefs } from './config';
import { expandDates, occurrenceStart, addDays } from '../meetings/engine/recurrence';
import { MEETING_SELECT, participantsOf, seriesOf, type MeetingRow } from '../meetings/engine/store';

export interface Slot { start: number; end: number }
export interface AvailabilityExclude { meetingId?: number | null; trainingEventId?: number | null; sessionId?: number | null; taskId?: number | null }
type Busy = TaskerBusyInterval & { excluded?: boolean };

const BITRIX_TTL_SEC = 150;
const mskYmd = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 10);
const overlaps = (a: Slot, b: Slot) => a.start < b.end && b.start < a.end;

// ── Битрикс ─────────────────────────────────────────────────────────────────

/** Смещение часового пояса (мс) в момент utcMs — через Intl, без библиотек. */
function tzOffsetMs(tz: string, utcMs: number): number {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
  } catch {
    return 3 * 3600_000;
  }
}

/** 'dd.mm.yyyy HH:MM:SS' в поясе tz → UTC ms. */
export function parseBxDate(s: string, tz: string | null | undefined): number | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s?.trim() ?? '');
  if (!m) return null;
  const wall = Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  const zone = tz || 'Europe/Moscow';
  const guess = wall - tzOffsetMs(zone, wall);
  return wall - tzOffsetMs(zone, guess);
}

interface BxAccess { ID?: string; NAME?: string; DATE_FROM: string; DATE_TO: string; DT_SKIP_TIME?: string; ACCESSIBILITY?: string; TZ_FROM?: string | null; TZ_TO?: string | null }

async function bitrixBusy(ids: string[], fromYmd: string, toYmd: string): Promise<Map<string, Busy[]>> {
  const out = new Map<string, Busy[]>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).sort();
    const res = await cached(`tasker:access:v1:${fromYmd}:${toYmd}:${chunk.join(',')}`, BITRIX_TTL_SEC, async () => {
      const r = await bx(taskWebhook(), 'calendar.accessibility.get', { users: chunk.map(Number), from: fromYmd, to: toYmd }) as { result?: Record<string, BxAccess[]> | unknown[] };
      return (r?.result && !Array.isArray(r.result) ? r.result : {}) as Record<string, BxAccess[]>;
    });
    for (const [uid, evs] of Object.entries(res)) {
      const list: Busy[] = [];
      for (const e of evs ?? []) {
        if ((e.ACCESSIBILITY ?? 'busy') === 'free') continue;
        const allDay = e.DT_SKIP_TIME === 'Y';
        let start = parseBxDate(allDay ? e.DATE_FROM.slice(0, 10) : e.DATE_FROM, allDay ? 'Europe/Moscow' : e.TZ_FROM);
        let end = parseBxDate(allDay ? e.DATE_TO.slice(0, 10) : e.DATE_TO, allDay ? 'Europe/Moscow' : (e.TZ_TO ?? e.TZ_FROM));
        if (start === null || end === null) continue;
        if (allDay) end += 86_400_000; // весь день: до конца последнего дня
        if (end <= start) end = start + 60_000;
        list.push({
          start: new Date(start).toISOString(), end: new Date(end).toISOString(), source: 'bitrix', allDay,
          title: e.ACCESSIBILITY === 'absent' ? `${e.NAME || 'Отсутствует'} (отсутствует)` : (e.NAME || 'Занят в календаре'),
        });
      }
      out.set(String(uid), list);
    }
  }
  return out;
}

// ── Монолитика ──────────────────────────────────────────────────────────────

function push(map: Map<string, Busy[]>, who: string, b: Busy) {
  const list = map.get(who);
  if (list) list.push(b); else map.set(who, [b]);
}
const ignoreMissing = (e: unknown) => { if ((e as { code?: string })?.code !== '42P01') throw e; };

async function monolitikaBusy(want: Set<string>, from: number, to: number, ex: AvailabilityExclude): Promise<Map<string, Busy[]>> {
  const out = new Map<string, Busy[]>();
  const fromIso = new Date(from - 86_400_000).toISOString();
  const toIso = new Date(to + 86_400_000).toISOString();
  const db = systemDb();
  const labels = new Map((await loadMetricDefs().catch(() => [])).map(m => [m.id, m.label]));

  // Сессии РОПа: РОП + менеджеры её задач.
  await db.query<{ id: string; rop_bitrix_id: string; metric_id: string; slot_start: Date; duration_min: number; managers: string[] | null }>(
    `SELECT s.id, s.rop_bitrix_id, s.metric_id, s.slot_start, s.duration_min,
            (SELECT array_agg(DISTINCT t.manager_bitrix_id) FROM tasker_tasks t WHERE t.session_id = s.id AND t.cancelled_at IS NULL) AS managers
       FROM tasker_sessions s WHERE s.slot_start BETWEEN $1 AND $2`, [fromIso, toIso],
  ).then(r => {
    for (const s of r.rows) {
      const start = new Date(s.slot_start).getTime();
      const b: Busy = { start: new Date(start).toISOString(), end: new Date(start + s.duration_min * 60_000).toISOString(), source: 'session',
        title: `Сессия · ${labels.get(s.metric_id) ?? s.metric_id}`, excluded: ex.sessionId === Number(s.id) };
      for (const who of new Set([s.rop_bitrix_id, ...(s.managers ?? [])])) if (want.has(who)) push(out, who, b);
    }
  }).catch(ignoreMissing);

  // Слоты задач вне сессий: менеджер + РОП.
  await db.query<{ id: string; manager_bitrix_id: string; rop_bitrix_id: string | null; title: string; slot_start: Date; slot_end: Date | null; duration_min: number }>(
    `SELECT id, manager_bitrix_id, rop_bitrix_id, title, slot_start, slot_end, duration_min FROM tasker_tasks
      WHERE cancelled_at IS NULL AND session_id IS NULL AND slot_start BETWEEN $1 AND $2`, [fromIso, toIso],
  ).then(r => {
    for (const t of r.rows) {
      const start = new Date(t.slot_start).getTime();
      const end = t.slot_end ? new Date(t.slot_end).getTime() : start + t.duration_min * 60_000;
      const b: Busy = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), source: 'task', title: `Задача · ${t.title}`, excluded: ex.taskId === Number(t.id) };
      for (const who of new Set([t.manager_bitrix_id, t.rop_bitrix_id].filter((x): x is string => !!x))) if (want.has(who)) push(out, who, b);
    }
  }).catch(ignoreMissing);

  // Обучения (сессия D): тренер + записанные.
  await db.query<{ id: string; title: string; start_at: Date; duration_min: number; trainer: string | null; managers: string[] | null }>(
    `SELECT e.id, e.title, e.start_at, e.duration_min, e.trainer_bitrix_user_id AS trainer,
            (SELECT array_agg(x.manager_bitrix_user_id) FROM tasker_training_enrollments x WHERE x.event_id = e.id) AS managers
       FROM tasker_training_events e WHERE e.cancelled_at IS NULL AND e.start_at BETWEEN $1 AND $2`, [fromIso, toIso],
  ).then(r => {
    for (const e of r.rows) {
      const start = new Date(e.start_at).getTime();
      const b: Busy = { start: new Date(start).toISOString(), end: new Date(start + e.duration_min * 60_000).toISOString(), source: 'training',
        title: `Обучение · ${e.title}`, excluded: ex.trainingEventId === Number(e.id) };
      for (const who of new Set([e.trainer, ...(e.managers ?? [])].filter((x): x is string => !!x))) if (want.has(who)) push(out, who, b);
    }
  }).catch(ignoreMissing);

  // Регулярные собрания: вхождения в окне без отменённых; организатор + участники.
  await db.query<MeetingRow>(`${MEETING_SELECT} WHERE m.cancelled_at IS NULL`).then(async r => {
    const memo = new Map<string, Promise<{ managerId: string; name: string }[]>>();
    for (const m of r.rows) {
      const dates = expandDates(seriesOf(m), addDays(mskYmd(from), -1), addDays(mskYmd(to), 1));
      if (!dates.length) continue;
      const people = [m.organizer_bitrix_id, ...(await participantsOf(m, memo)).map(p => String(p.id))].filter(x => want.has(x));
      if (!people.length) continue;
      const cancelled = new Set(m.cancelled_dates ?? []);
      for (const d of dates) {
        if (cancelled.has(d)) continue;
        const start = new Date(occurrenceStart(d, m.start_time)).getTime();
        const b: Busy = { start: new Date(start).toISOString(), end: new Date(start + m.duration_min * 60_000).toISOString(), source: 'meeting',
          title: `Собрание · ${m.title}`, excluded: ex.meetingId === Number(m.id) };
        for (const who of new Set(people)) push(out, who, b);
      }
    }
  }).catch(ignoreMissing);

  return out;
}

// ── Сведение ────────────────────────────────────────────────────────────────

const SOURCE_GENERIC: Record<TaskerBusySource, string> = {
  bitrix: 'Занят в календаре', session: 'Сессия РОПа', training: 'Обучение', meeting: 'Собрание', task: 'Задача',
};

/**
 * Занятость людей на слотах. canSeeTitle(id) — показывать ли названия событий этого человека (вне зоны
 * пользователя — только «занят» и источник).
 */
export async function checkAvailability(
  personIds: string[], slots: Slot[], exclude: AvailabilityExclude, canSeeTitle: (id: string) => boolean,
): Promise<TaskerAvailabilityResponse> {
  const people = [...new Set(personIds.filter(id => /^\d+$/.test(id)))];
  if (!people.length || !slots.length) return { busy: [], checkedCount: people.length, bitrixChecked: true };
  const from = Math.min(...slots.map(s => s.start));
  const to = Math.max(...slots.map(s => s.end));
  const want = new Set(people);

  const [mono, bitrix, dir] = await Promise.all([
    monolitikaBusy(want, from, to, exclude),
    bitrixBusy(people, mskYmd(from), mskYmd(to)).then(m => ({ ok: true as const, m }), e => {
      console.warn('[tasker] calendar.accessibility.get:', e instanceof Error ? e.message : e);
      return { ok: false as const, m: new Map<string, Busy[]>() };
    }),
    getEmployeeDirectory(),
  ]);

  const busy: TaskerAvailabilityPerson[] = [];
  for (const id of people) {
    const own = mono.get(id) ?? [];
    const ownKeys = new Set(own.map(b => `${b.start}|${b.end}`));
    const all: Busy[] = [
      ...own.filter(b => !b.excluded),
      ...(bitrix.m.get(id) ?? []).filter(b => !ownKeys.has(`${b.start}|${b.end}`)),
    ];
    const titled = canSeeTitle(id);
    const conflicts: TaskerAvailabilityPerson['conflicts'] = [];
    const seen = new Set<string>();
    slots.forEach((slot, slotIndex) => {
      for (const b of all) {
        if (!overlaps(slot, { start: Date.parse(b.start), end: Date.parse(b.end) })) continue;
        const key = `${slotIndex}|${b.start}|${b.end}|${b.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { excluded: _x, ...rest } = b;
        void _x;
        conflicts.push({ ...rest, title: titled ? b.title : SOURCE_GENERIC[b.source], slotIndex });
      }
    });
    if (conflicts.length) {
      conflicts.sort((a, b) => a.start.localeCompare(b.start));
      busy.push({ id: Number(id), name: dir.get(Number(id))?.name ?? `#${id}`, conflicts });
    }
  }
  busy.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { busy, checkedCount: people.length, bitrixChecked: bitrix.ok };
}
