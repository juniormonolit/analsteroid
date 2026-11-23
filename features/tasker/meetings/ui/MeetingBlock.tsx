'use client';
// Карточка вхождения регулярного собрания в «Неделе»/«Сегодня» Задачника: иконка повтора, время, название,
// длительность, организатор, сколько участников. Отменённая встреча — зачёркнута. Клик — в «Собрания».
import Link from 'next/link';
import { Repeat } from 'lucide-react';
import type { TaskerMeetingOccurrence } from '../../types';
import { fmtTime, shortName } from '../../ui/shared/format';

export function MeetingBlock({ m }: { m: TaskerMeetingOccurrence }) {
  return (
    <Link href={`/tasker/meetings?meeting=${m.meetingId}`}
      className={`block min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 text-xs hover:border-[var(--color-border-strong)] ${m.cancelled ? 'opacity-60' : ''}`}
      title={m.recurrenceLabel}>
      <div className="flex min-w-0 items-center gap-1.5 font-semibold text-[var(--color-text)]">
        <Repeat size={14} className="shrink-0 text-[var(--color-positive)]" aria-label="Регулярное собрание" />
        <span className="shrink-0 tabular-nums">{fmtTime(m.startsAt)}</span>
        <span className={`min-w-0 truncate ${m.cancelled ? 'line-through' : ''}`}>Собрание · {m.title}</span>
      </div>
      <div className="mt-0.5 min-w-0 truncate text-[var(--color-text-muted)]">
        {m.cancelled ? 'отменено · ' : ''}{m.durationMin} мин · {shortName(m.organizer.name)} · {m.participantsCount} уч.{m.place ? ` · ${m.place}` : ''}
      </div>
    </Link>
  );
}
