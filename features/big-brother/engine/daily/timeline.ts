// «Большой брат», поток D — лента дня человека (вживую из источников) и календарь по дням (из activity_daily).
import { systemDb } from '@/lib/db/clients';
import { foldDay } from './build';
import type { MonitoredPerson } from './people';
import { loadSourceEvents, loadTaskStats } from './sources';
import { addDays, dayBounds, isWorkday, mskAt, mskDate } from './time';
import { GAP_MIN, type CalendarDayDto, type DailyRowDto, type PersonCalendarResponse, type PersonDayResponse } from './types';

/** Окно рабочего дня для оси ленты — из настроек сторожа (idle_watch_settings), дефолт 9–18 МСК. */
async function workWindow(): Promise<{ start: number; end: number }> {
  try {
    const r = await systemDb().query(`SELECT window_start_hour, window_end_hour FROM idle_watch_settings WHERE id = 1`);
    const s = r.rows[0];
    const start = Number(s?.window_start_hour ?? 9), end = Number(s?.window_end_hour ?? 18);
    return start >= 0 && end <= 24 && start < end ? { start, end } : { start: 9, end: 18 };
  } catch {
    return { start: 9, end: 18 };
  }
}

export async function personDay(person: MonitoredPerson, date: string, now = Date.now()): Promise<PersonDayResponse> {
  const { from, to, asOf } = dayBounds(date, now);
  const [src, tasks, win] = await Promise.all([
    loadSourceEvents([person.id], from, to),
    loadTaskStats([person.id], from, to, asOf).catch(() => new Map<string, { closed: number; overdue: number }>()),
    workWindow(),
  ]);
  const day = foldDay({ date, person, events: src.events, monoBuckets: src.monoBuckets, tasks: tasks.get(person.id), workday: isWorkday(date) });

  // События ленты: Монолитика — ещё и активные бакеты (присутствие без кликов), по одной точке на бакет.
  const events = src.events.map(e => ({
    at: new Date(e.at).toISOString(), band: e.band, kind: e.kind, action: e.action, weak: e.weak, n: e.n,
  }));
  const seenBucket = new Set<number>();
  for (const b of src.monoBuckets) {
    if (seenBucket.has(b.at)) continue;
    seenBucket.add(b.at);
    events.push({ at: new Date(b.at).toISOString(), band: 'mono', kind: 'mono_minute', action: b.section || null, weak: false, n: 1 });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));

  // Провалы внутри рабочего окна (только рабочий день): разрывы между сильными сигналами ≥ GAP_MIN.
  const gaps: { from: string; to: string }[] = [];
  if (day.isWorkday) {
    const ws = mskAt(date, win.start).getTime();
    const we = Math.min(mskAt(date, win.end).getTime(), now);
    const strong = [...new Set(events.filter(e => !e.weak).map(e => Date.parse(e.at)))].filter(t => t >= ws && t <= we).sort((a, b) => a - b);
    let cur = ws;
    for (const t of [...strong, we]) {
      if (t - cur >= GAP_MIN * 60_000) gaps.push({ from: new Date(cur).toISOString(), to: new Date(t).toISOString() });
      cur = Math.max(cur, t);
    }
  }

  return {
    date,
    person: { id: person.id, name: person.name, role: person.role, departmentName: person.departmentName, ropName: person.ropName },
    day, events, windowStartHour: win.start, windowEndHour: win.end, gaps, failedSources: src.failed,
  };
}

/** Календарь за последние `days` дней (по умолчанию год, до сегодня включительно). */
export async function personCalendar(id: string, days = 371, now = Date.now()): Promise<PersonCalendarResponse> {
  const to = mskDate(now);
  const from = addDays(to, -(days - 1));
  const r = await systemDb().query<{
    d: string; is_workday: boolean | null; in_work: boolean; mono_minutes: number; counts: Record<string, number>;
    tasks_created: number; tasks_closed: number;
  }>(
    `SELECT to_char(snap_date, 'YYYY-MM-DD') AS d, is_workday, in_work, mono_minutes, counts, tasks_created, tasks_closed
       FROM activity_daily WHERE bitrix_user_id = $1 AND snap_date BETWEEN $2::date AND $3::date ORDER BY snap_date`,
    [id, from, to],
  );
  const days_: CalendarDayDto[] = r.rows.map(x => {
    const c = x.counts ?? {};
    return {
      date: x.d, isWorkday: x.is_workday, inWork: x.in_work, buckets: Number(c.buckets ?? 0), monoMinutes: x.mono_minutes,
      calls: (c['call.out_reached'] ?? 0) + (c['call.out_attempt'] ?? 0) + (c['call.in'] ?? 0),
      deals: (c.deal_stage ?? 0) + (c.deal_new ?? 0),
      tasks: (c['task.create'] ?? 0) + (c['task.close'] ?? 0),
    };
  });
  return { from, to, days: days_ };
}

export function toDailyDto(x: Record<string, unknown>): DailyRowDto {
  const counts = (x.counts ?? {}) as Record<string, number>;
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    date: String(x.d), bitrixUserId: String(x.bitrix_user_id), name: (x.user_name as string) ?? null,
    departmentId: (x.department_id as string) ?? null, departmentName: (x.department_name as string) ?? null,
    ropBitrixId: (x.rop_bitrix_id as string) ?? null, isWorkday: (x.is_workday as boolean) ?? null, inWork: !!x.in_work,
    monoMinutes: Number(x.mono_minutes ?? 0), buckets: Number(counts.buckets ?? 0),
    firstSignalAt: iso(x.first_signal_at), lastSignalAt: iso(x.last_signal_at), counts,
    sections: (x.sections ?? {}) as Record<string, number>, surfaces: (x.surfaces ?? {}) as Record<string, number>,
    tasksCreated: Number(x.tasks_created ?? 0), tasksClosed: Number(x.tasks_closed ?? 0), tasksOverdue: Number(x.tasks_overdue ?? 0),
  };
}
