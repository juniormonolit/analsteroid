'use client';
// «Сегодня» Задачника — повестка дня (ТЗ): сессии и обучения дня (по времени), просроченное,
// сроки сегодня, замеры сегодня. Задача может попасть в несколько блоков (слот сегодня и срок
// сегодня) — это нормально: каждый блок отвечает на свой вопрос.
import { useMemo } from 'react';
import type { TaskerMeetingOccurrence, TaskerSession, TaskerTask, TrainingEnrollment } from '../../types';
import { fmtDayLong, isOpen, isOverdue, mskDay, todayMsk } from '../shared/format';
import { TaskCard } from '../shared/TaskCard';
import { DayItems, layoutDays } from '../week/TaskerWeek';

function Block({ title, hint, count, tone, children }: { title: string; hint: string; count: number; tone?: 'neg'; children: React.ReactNode }) {
  // Пустой блок не занимает полэкрана словом «нет» — сворачивается в строку итогов (аудит 23.11).
  if (count === 0) return null;
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2 rounded-xl bg-[var(--color-bg-surface)] p-3">
      <header className="flex min-w-0 items-baseline gap-2">
        <h2 className={`text-sm font-semibold ${tone === 'neg' && count > 0 ? 'text-[var(--color-negative)]' : 'text-[var(--color-text)]'}`}>{title}</h2>
        <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{count}</span>
      </header>
      <p className="-mt-1 text-xs text-[var(--color-text-muted)]">{hint}</p>
      {children}
    </section>
  );
}

export function TaskerToday({ tasks, sessions, trainings, meetings = [], onOpen }: {
  tasks: TaskerTask[];
  sessions: TaskerSession[];
  trainings: TrainingEnrollment[];
  meetings?: TaskerMeetingOccurrence[];
  onOpen: (t: TaskerTask) => void;
}) {
  const today = todayMsk();
  const { agenda, overdue, dueToday, measureToday } = useMemo(() => {
    const items = layoutDays([today], tasks, sessions, trainings, meetings).get(today) ?? [];
    return {
      // В «расписании» — то, что привязано ко времени: сессии, собрания, обучения, задачи со слотом.
      agenda: items.filter(i => i.kind !== 'task' || i.bySlot),
      overdue: tasks.filter(t => isOverdue(t)).sort((a, b) => a.deadline.localeCompare(b.deadline)),
      dueToday: tasks.filter(t => isOpen(t) && !isOverdue(t) && mskDay(t.deadline) === today).sort((a, b) => a.deadline.localeCompare(b.deadline)),
      measureToday: tasks.filter(t => t.controlDate === today),
    };
  }, [today, tasks, sessions, trainings, meetings]);

  const cards = (list: TaskerTask[]) => (
    <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
      {list.map(t => <TaskCard key={t.id} task={t} onOpen={onOpen} />)}
    </div>
  );

  const empty = [
    { label: 'Расписание', n: agenda.length },
    { label: 'Просрочено', n: overdue.length },
    { label: 'Срок сегодня', n: dueToday.length },
    { label: 'Замер сегодня', n: measureToday.length },
  ].filter(x => x.n === 0);
  const allEmpty = empty.length === 4;

  return (
    <div className="flex min-w-0 flex-col gap-3 px-4 pb-6 pt-3 sm:px-6">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-[var(--color-text)] first-letter:uppercase">{fmtDayLong(today)}</span>
        {!allEmpty && empty.length > 0 && (
          <span className="text-xs text-[var(--color-text-muted)]">{empty.map(x => `${x.label} — нет`).join(' · ')}</span>
        )}
      </div>
      {allEmpty && (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
          На сегодня ничего: нет сессий, просрочек, сроков и замеров. План на неделю — во вкладке «Неделя».
        </div>
      )}
      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
        <Block title="Просрочено" hint="Срок прошёл, а задача не сдана" count={overdue.length} tone="neg">{cards(overdue)}</Block>
        <Block title="Расписание дня" hint="Сессии, собрания, обучения и задачи со слотом — по времени" count={agenda.length}>
          <div className="flex min-w-0 flex-col gap-2"><DayItems items={agenda} onOpen={onOpen} /></div>
        </Block>
        <Block title="Срок сегодня" hint="Сдать до конца дня" count={dueToday.length}>{cards(dueToday)}</Block>
        <Block title="Замер сегодня" hint="Сегодня система пересчитает показатель и поставит вердикт" count={measureToday.length}>{cards(measureToday)}</Block>
      </div>
    </div>
  );
}
