// «Большой брат», поток D — сборка дневного агрегата activity_daily (миграция 296; BIG_BROTHER_SPEC.md, «Данные»).
//
// Снимок на (snap_date, bitrix_user_id) для всех, кого мониторим (people.ts: продажи + логисты), включая тех, у кого
// за день нет ни одного сигнала (in_work = false — календарь показывает «нет сигнала» в рабочий день).
//   mono_minutes   — активные 5-мин бакеты Монолитики (activity_minutes, source = 'mono') × 5;
//   first/last     — первый/последний СИЛЬНЫЙ сигнал дня по всем источникам (слабые — sources.ts — не в счёт);
//   in_work        — был хоть один сильный сигнал (то же определение, что у сторожа, lib/bots/idleWatch.ts);
//   counts         — {kind: n, 'kind.action': n} по всем событиям + служебный ключ `buckets` — число 5-мин отрезков
//                    с сильным сигналом из любого источника (интенсивность календаря);
//   sections/surfaces — минуты Монолитики по разделам / режимам запуска;
//   tasks_*        — поставлено (created_by), закрыто ответственным за день, просрочено на конец дня (sources.ts).
// Планирование — instrumentation.ts (scheduleActivityDaily, ключ activityDaily): ночью вчерашний день + досборка
// пропусков за год, днём раз в 15 мин — «сегодня».
import { systemDb } from '@/lib/db/clients';
import { ACTIVITY_BUCKET_MIN } from '@/lib/activity/types';
import { loadMonitoredPeople, type MonitoredPerson } from './people';
import { loadSourceEvents, loadTaskStats, type MonoBucket, type SourceEvent } from './sources';
import { addDays, dayBounds, isWorkday, mskDate } from './time';
import type { DailyRowDto } from './types';

const BUCKET_MS = ACTIVITY_BUCKET_MIN * 60_000;

/** Свернуть события и бакеты одного человека за день в строку агрегата. */
export function foldDay(o: {
  date: string; person: MonitoredPerson; events: SourceEvent[]; monoBuckets: MonoBucket[];
  tasks: { closed: number; overdue: number } | undefined; workday: boolean;
}): DailyRowDto {
  const counts: Record<string, number> = {};
  const strongBuckets = new Set<number>();
  let first: number | null = null, last: number | null = null, created = 0;
  const bump = (k: string, n: number) => { counts[k] = (counts[k] ?? 0) + n; };
  const strong = (at: number) => {
    strongBuckets.add(Math.floor(at / BUCKET_MS));
    if (first == null || at < first) first = at;
    if (last == null || at > last) last = at;
  };
  for (const e of o.events) {
    bump(e.kind, e.n);
    if (e.action && e.kind !== 'mono_view') bump(`${e.kind}.${e.action}`, e.n);
    if (e.kind === 'task' && e.action === 'create') created += e.n;
    if (!e.weak) strong(e.at);
  }
  const bucketSet = new Set<number>();
  const sections: Record<string, number> = {}, surfaces: Record<string, number> = {};
  const secSeen = new Set<string>(), surfSeen = new Set<string>();
  for (const b of o.monoBuckets) {
    bucketSet.add(b.at);
    strong(b.at);
    const sk = `${b.at}|${b.section}`, fk = `${b.at}|${b.surface}`;
    if (b.section && !secSeen.has(sk)) { secSeen.add(sk); sections[b.section] = (sections[b.section] ?? 0) + ACTIVITY_BUCKET_MIN; }
    if (b.surface && !surfSeen.has(fk)) { surfSeen.add(fk); surfaces[b.surface] = (surfaces[b.surface] ?? 0) + ACTIVITY_BUCKET_MIN; }
  }
  counts.buckets = strongBuckets.size;
  const p = o.person;
  return {
    date: o.date, bitrixUserId: p.id, name: p.name, departmentId: p.departmentId, departmentName: p.departmentName,
    ropBitrixId: p.ropId, isWorkday: o.workday, inWork: first != null,
    monoMinutes: bucketSet.size * ACTIVITY_BUCKET_MIN, buckets: strongBuckets.size,
    firstSignalAt: first != null ? new Date(first).toISOString() : null,
    lastSignalAt: last != null ? new Date(last).toISOString() : null,
    counts, sections, surfaces,
    tasksCreated: created, tasksClosed: o.tasks?.closed ?? 0, tasksOverdue: o.tasks?.overdue ?? 0,
  };
}

function groupBy<T extends { mid: string }>(list: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of list) { const l = m.get(x.mid); if (l) l.push(x); else m.set(x.mid, [x]); }
  return m;
}

/** Посчитать агрегат за дату (без записи). people — кого (по умолчанию все мониторимые). */
export async function computeDaily(date: string, opts: { people?: MonitoredPerson[]; now?: number } = {}): Promise<{
  rows: DailyRowDto[]; failed: string[];
}> {
  const people = opts.people ?? await loadMonitoredPeople();
  const ids = people.map(p => p.id);
  const { from, to, asOf } = dayBounds(date, opts.now);
  const [src, tasks] = await Promise.all([
    loadSourceEvents(ids, from, to),
    loadTaskStats(ids, from, to, asOf).catch(e => {
      console.warn('[activityDaily] задачи (закрыто/просрочено):', e instanceof Error ? e.message : e);
      return new Map<string, { closed: number; overdue: number }>();
    }),
  ]);
  const ev = groupBy(src.events), mb = groupBy(src.monoBuckets);
  const workday = isWorkday(date);
  return {
    rows: people.map(person => foldDay({
      date, person, events: ev.get(person.id) ?? [], monoBuckets: mb.get(person.id) ?? [], tasks: tasks.get(person.id), workday,
    })),
    failed: src.failed,
  };
}

/** Записать строки агрегата (upsert по (snap_date, bitrix_user_id)) одним запросом. */
async function writeDaily(rows: DailyRowDto[]): Promise<number> {
  if (!rows.length) return 0;
  const payload = rows.map(r => ({
    snap_date: r.date, bitrix_user_id: r.bitrixUserId, user_name: r.name, department_id: r.departmentId,
    department_name: r.departmentName, rop_bitrix_id: r.ropBitrixId, is_workday: r.isWorkday, in_work: r.inWork,
    mono_minutes: r.monoMinutes, first_signal_at: r.firstSignalAt, last_signal_at: r.lastSignalAt,
    counts: r.counts, sections: r.sections, surfaces: r.surfaces,
    tasks_created: r.tasksCreated, tasks_closed: r.tasksClosed, tasks_overdue: r.tasksOverdue,
  }));
  const res = await systemDb().query(
    `INSERT INTO activity_daily (snap_date, bitrix_user_id, user_name, department_id, department_name, rop_bitrix_id,
                                 is_workday, in_work, mono_minutes, first_signal_at, last_signal_at, counts, sections,
                                 surfaces, tasks_created, tasks_closed, tasks_overdue, built_at)
     SELECT snap_date, bitrix_user_id, user_name, department_id, department_name, rop_bitrix_id, is_workday, in_work,
            mono_minutes, first_signal_at, last_signal_at, counts, sections, surfaces, tasks_created, tasks_closed,
            tasks_overdue, now()
       FROM jsonb_to_recordset($1::jsonb) AS x(
              snap_date date, bitrix_user_id text, user_name text, department_id text, department_name text,
              rop_bitrix_id text, is_workday boolean, in_work boolean, mono_minutes int, first_signal_at timestamptz,
              last_signal_at timestamptz, counts jsonb, sections jsonb, surfaces jsonb, tasks_created int,
              tasks_closed int, tasks_overdue int)
     ON CONFLICT (snap_date, bitrix_user_id) DO UPDATE SET
       user_name = EXCLUDED.user_name, department_id = EXCLUDED.department_id, department_name = EXCLUDED.department_name,
       rop_bitrix_id = EXCLUDED.rop_bitrix_id, is_workday = EXCLUDED.is_workday, in_work = EXCLUDED.in_work,
       mono_minutes = EXCLUDED.mono_minutes, first_signal_at = EXCLUDED.first_signal_at,
       last_signal_at = EXCLUDED.last_signal_at, counts = EXCLUDED.counts, sections = EXCLUDED.sections,
       surfaces = EXCLUDED.surfaces, tasks_created = EXCLUDED.tasks_created, tasks_closed = EXCLUDED.tasks_closed,
       tasks_overdue = EXCLUDED.tasks_overdue, built_at = now()`,
    [JSON.stringify(payload)],
  );
  return res.rowCount ?? 0;
}

/**
 * Собрать и записать агрегат за дату. Источник, который не прочитался, — повод НЕ затирать уже собранный день
 * неполными данными: для прошлой даты при сбое звонков/сделок/задач запись пропускается (повтор — следующим прогоном).
 */
export async function buildActivityDaily(date: string, opts: { people?: MonitoredPerson[]; now?: number } = {}): Promise<string> {
  const t0 = Date.now();
  const { rows, failed } = await computeDaily(date, opts);
  const critical = failed.filter(f => f.startsWith('va.') || f.startsWith('sa.'));
  if (critical.length && date < mskDate(opts.now ?? Date.now())) {
    return `${date}: пропущено — не прочитались ${critical.join(', ')}`;
  }
  const n = await writeDaily(rows);
  const inWork = rows.filter(r => r.inWork).length;
  return `${date}: ${n} строк, в работе ${inWork}, ${Math.round((Date.now() - t0) / 100) / 10} с${failed.length ? `, без ${failed.join(', ')}` : ''}`;
}

/** Даты за последние `days` дней до вчера включительно, за которые агрегата нет (новые первыми). */
async function missingDates(days: number, now: number): Promise<string[]> {
  const yesterday = addDays(mskDate(now), -1);
  const since = addDays(yesterday, -(days - 1));
  const r = await systemDb().query<{ d: string }>(
    `SELECT DISTINCT to_char(snap_date, 'YYYY-MM-DD') AS d FROM activity_daily WHERE snap_date >= $1::date`, [since],
  );
  const have = new Set(r.rows.map(x => x.d));
  const out: string[] = [];
  for (let d = yesterday; d >= since; d = addDays(d, -1)) if (!have.has(d)) out.push(d);
  return out;
}

/** Ночной прогон: вчерашний день начисто + досборка пропусков за год (не больше maxBackfill дат за прогон). */
export async function runActivityDailyNightly(o: { now?: number; maxBackfill?: number; backfillDays?: number } = {}): Promise<string[]> {
  const now = o.now ?? Date.now();
  const people = await loadMonitoredPeople();
  const log: string[] = [await buildActivityDaily(addDays(mskDate(now), -1), { people, now })];
  const gaps = (await missingDates(o.backfillDays ?? 365, now)).slice(0, o.maxBackfill ?? 30);
  for (const d of gaps) log.push(await buildActivityDaily(d, { people, now }));
  return log;
}

/** Дневной пересчёт «сегодня». */
export async function runActivityDailyToday(now = Date.now()): Promise<string> {
  return buildActivityDaily(mskDate(now), { now });
}
