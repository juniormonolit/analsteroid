'use client';
// Неделя Задачника: 5 рабочих дней (пн–пт), в каждом — по времени: сессии РОПа (задачи
// сессии внутри), задачи по плановому слоту (нет слота — по сроку), записи на обучения и встречи
// регулярных собраний (features/tasker/meetings).
// Десктоп — 5 колонок; планшет — 2; телефон — дни списком сверху вниз.
import { CalendarClock, GraduationCap, Users } from 'lucide-react';
import type { TaskerMeetingOccurrence, TaskerSession, TaskerTask, TrainingEnrollment } from '../../types';
import { MeetingBlock } from '../../meetings/ui/MeetingBlock';
import { addDays, fmtDayLong, fmtTime, mskDay, shortName, todayMsk } from '../shared/format';
import { TaskCard } from '../shared/TaskCard';

type Item =
  | { kind: 'session'; at: string; session: TaskerSession; tasks: TaskerTask[] }
  | { kind: 'task'; at: string; task: TaskerTask; bySlot: boolean }
  | { kind: 'training'; at: string; training: TrainingEnrollment[] }
  | { kind: 'meeting'; at: string; meeting: TaskerMeetingOccurrence };

export function weekDays(monday: string) { return [0, 1, 2, 3, 4].map(i => addDays(monday, i)); }

/** Раскладка по дням: ключ — YYYY-MM-DD МСК. Общая с «Сегодня». */
export function layoutDays(days: string[], tasks: TaskerTask[], sessions: TaskerSession[], trainings: TrainingEnrollment[], meetings: TaskerMeetingOccurrence[] = []): Map<string, Item[]> {
  const res = new Map<string, Item[]>(days.map(d => [d, []]));
  const byId = new Map(tasks.map(t => [t.id, t]));
  const inSession = new Set<number>();
  for (const s of sessions) {
    const list = res.get(mskDay(s.slotStart));
    const st = s.taskIds.map(id => byId.get(id)).filter((t): t is TaskerTask => !!t);
    for (const t of st) inSession.add(t.id);
    list?.push({ kind: 'session', at: s.slotStart, session: s, tasks: st });
  }
  for (const t of tasks) {
    if (inSession.has(t.id)) continue;
    const slotDay = t.slotStart ? mskDay(t.slotStart) : null;
    if (slotDay && res.has(slotDay)) { res.get(slotDay)!.push({ kind: 'task', at: t.slotStart!, task: t, bySlot: true }); continue; }
    const dlDay = mskDay(t.deadline);
    // Срок — в конец дня: задачи со слотом идут раньше задач «до 18:00».
    res.get(dlDay)?.push({ kind: 'task', at: `${dlDay}T23:59:00Z`, task: t, bySlot: false });
  }
  // Одно обучение, на которое записаны несколько менеджеров, — одним блоком.
  const byEvent = new Map<number, TrainingEnrollment[]>();
  for (const e of trainings) byEvent.set(e.eventId, [...(byEvent.get(e.eventId) ?? []), e]);
  for (const list of byEvent.values()) res.get(mskDay(list[0].startsAt))?.push({ kind: 'training', at: list[0].startsAt, training: list });
  for (const m of meetings) res.get(m.date)?.push({ kind: 'meeting', at: m.startsAt, meeting: m });
  for (const list of res.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  return res;
}

export function SessionBlock({ session: s, tasks, onOpen }: { session: TaskerSession; tasks: TaskerTask[]; onOpen: (t: TaskerTask) => void }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] p-2.5 text-xs">
      <div className="flex min-w-0 items-start gap-1.5 font-semibold text-[var(--color-text)]">
        <Users size={14} className="shrink-0 text-[var(--color-accent)]" aria-hidden />
        <span className="shrink-0 tabular-nums">{fmtTime(s.slotStart)}</span>
        <span className="line-clamp-2 min-w-0 break-words" title={`Сессия · ${s.metricLabel}`}>{s.metricLabel}</span>
      </div>
      <div className="mt-0.5 text-[var(--color-text-muted)]">Сессия {s.durationMin} мин · ведёт {shortName(s.rop.name)}</div>
      <div className="mt-1.5 flex min-w-0 flex-wrap gap-1">
        {tasks.length > 0 ? tasks.map(t => (
          <button key={t.id} type="button" onClick={() => onOpen(t)}
            className="inline-flex min-h-9 max-w-full items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[var(--color-text)] hover:border-[var(--color-border-strong)]">
            <span className="truncate">{shortName(t.manager.name)}</span>
          </button>
        )) : s.managers.map(m => <span key={m.id} className="rounded-md bg-[var(--color-bg)] px-2 py-1">{shortName(m.name)}</span>)}
      </div>
    </div>
  );
}

export function TrainingBlock({ list }: { list: TrainingEnrollment[] }) {
  const e = list[0];
  return (
    <div className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 text-xs" title={e.place ?? undefined}>
      <div className="flex min-w-0 items-start gap-1.5 font-semibold text-[var(--color-text)]">
        <GraduationCap size={14} className="shrink-0 text-[var(--color-warning)]" aria-hidden />
        <span className="shrink-0 tabular-nums">{fmtTime(e.startsAt)}</span>
        <span className="line-clamp-2 min-w-0 break-words" title={`Обучение · ${e.title}`}>{e.title}</span>
      </div>
      <div className="mt-0.5 min-w-0 truncate text-[var(--color-text-muted)]">
        Обучение {e.durationMin} мин{e.place ? ` · ${e.place}` : ''}{e.trainer ? ` · ${shortName(e.trainer.name)}` : ''}
      </div>
      <div className="mt-0.5 min-w-0 break-words text-[var(--color-text-secondary)]">Записаны: {list.map(x => shortName(x.manager.name)).join(', ')}</div>
    </div>
  );
}

export function DayItems({ items, onOpen }: { items: Item[]; onOpen: (t: TaskerTask) => void }) {
  return (
    <>
      {items.map(it => it.kind === 'session' ? (
        <SessionBlock key={`s${it.session.id}`} session={it.session} tasks={it.tasks} onOpen={onOpen} />
      ) : it.kind === 'meeting' ? (
        <MeetingBlock key={`m${it.meeting.meetingId}-${it.meeting.date}`} m={it.meeting} />
      ) : it.kind === 'training' ? (
        <TrainingBlock key={`e${it.training[0].eventId}`} list={it.training} />
      ) : (
        <div key={`t${it.task.id}`} className="min-w-0">
          {it.bySlot && <div className="mb-0.5 text-[11px] tabular-nums text-[var(--color-text-muted)]">{fmtTime(it.at)}</div>}
          <TaskCard task={it.task} onOpen={onOpen} compact />
        </div>
      ))}
    </>
  );
}

export function TaskerWeek({ monday, tasks, sessions, trainings, meetings = [], onOpen }: {
  monday: string;
  tasks: TaskerTask[];
  sessions: TaskerSession[];
  trainings: TrainingEnrollment[];
  meetings?: TaskerMeetingOccurrence[];
  onOpen: (t: TaskerTask) => void;
}) {
  const days = weekDays(monday);
  const byDay = layoutDays(days, tasks, sessions, trainings, meetings);
  const today = todayMsk();
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2.5 px-4 pb-6 pt-3 sm:grid-cols-2 sm:px-6 lg:grid-cols-5">
      {days.map(d => {
        const items = byDay.get(d) ?? [];
        const isToday = d === today;
        // Замеры дня — как в «Сегодня» (аудит 23.11, п.36): мелкими чипами внизу, клик — карточка задачи.
        const measures = tasks.filter(t => t.controlDate === d && !t.verdict);
        return (
          <section key={d} aria-label={fmtDayLong(d)}
            className={`flex min-w-0 flex-col gap-2 rounded-xl bg-[var(--color-bg-surface)] p-2 ${isToday ? 'ring-2 ring-[var(--color-accent)]' : ''}`}>
            <h2 className={`px-1 pt-0.5 text-sm font-semibold first-letter:uppercase ${isToday ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>
              {fmtDayLong(d)}{isToday ? ' · сегодня' : ''}
            </h2>
            <DayItems items={items} onOpen={onOpen} />
            {items.length === 0 && measures.length === 0 && <div className="px-1 pb-2 text-xs text-[var(--color-text-muted)]">—</div>}
            {measures.length > 0 && (
              <div className="mt-auto flex min-w-0 flex-col gap-1 border-t border-[var(--color-border)] px-1 pt-1.5">
                <span className="text-[11px] text-[var(--color-text-muted)]">Замер</span>
                <div className="flex min-w-0 flex-wrap gap-1">
                  {measures.map(t => (
                    <button key={t.id} type="button" onClick={() => onOpen(t)} title={`Автозамер: ${t.metricLabel} · ${t.manager.name}`}
                      className="inline-flex min-h-9 max-w-full items-center gap-1 rounded-md bg-[var(--color-bg)] px-2 text-[11.5px] hover:bg-[var(--color-bg-hover)]">
                      <CalendarClock size={12} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
                      <span className="truncate">{shortName(t.manager.name)} · {t.metricLabel}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
