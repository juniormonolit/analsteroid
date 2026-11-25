'use client';
// Выбор даты: ← день → и поле даты (не позже сегодняшнего дня МСК).
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { shiftDate, todayMsk } from './shared';

export function DateBar({ date, onChange }: { date: string; onChange: (d: string) => void }) {
  const today = todayMsk();
  const btn = 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40';
  return (
    <div className="flex min-w-0 items-center gap-1">
      <button type="button" className={btn} aria-label="Предыдущий день" onClick={() => onChange(shiftDate(date, -1))}>
        <ChevronLeft size={18} />
      </button>
      <input
        type="date" value={date} max={today} aria-label="Дата"
        onChange={e => { const v = e.target.value; if (v) onChange(v > today ? today : v); }}
        className="min-h-11 min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2 text-base text-[var(--color-text)] sm:text-sm"
      />
      <button type="button" className={btn} aria-label="Следующий день" disabled={date >= today} onClick={() => onChange(shiftDate(date, 1))}>
        <ChevronRight size={18} />
      </button>
      {date !== today && (
        <button type="button" onClick={() => onChange(today)}
          className="min-h-11 rounded-lg px-2 text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">Сегодня</button>
      )}
    </div>
  );
}
