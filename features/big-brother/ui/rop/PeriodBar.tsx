'use client';
// Период «с … по …» (МСК) + быстрые пресеты; значения живут в URL (?from&to), пусто — 30 дней по умолчанию.
import type { ReactNode } from 'react';
import { stringParam, useUrlState } from '@/lib/hooks/useUrlState';

const FIELD = 'min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base sm:text-sm text-[var(--color-text)]';
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const mskToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function usePeriod(): { from: string; to: string; set: (from: string, to: string) => void; custom: boolean } {
  const [fromRaw, setFrom] = useUrlState('from', stringParam(''));
  const [toRaw, setTo] = useUrlState('to', stringParam(''));
  const today = mskToday();
  const to = isDay(toRaw) ? toRaw : today;
  const from = isDay(fromRaw) ? fromRaw : shift(to, -29);
  return { from, to, custom: !!(fromRaw || toRaw), set: (f, t) => { setFrom(f); setTo(t); } };
}

export function PeriodBar({ children }: { children?: ReactNode }) {
  const p = usePeriod();
  const today = mskToday();
  const presets: [string, string, string][] = [
    ['30 дней', '', ''],
    ['Этот месяц', `${today.slice(0, 7)}-01`, today],
    ['90 дней', shift(today, -89), today],
  ];
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">С
        <input type="date" value={p.from} max={p.to} onChange={e => p.set(e.target.value, p.to)} className={FIELD} />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">по
        <input type="date" value={p.to} min={p.from} max={today} onChange={e => p.set(p.from, e.target.value)} className={FIELD} />
      </label>
      <div role="group" aria-label="Быстрый период" className="flex max-w-full flex-wrap rounded-lg bg-[var(--color-bg-surface)] p-0.5">
        {presets.map(([label, f, t]) => {
          const on = f === '' ? !p.custom : p.from === f && p.to === t;
          return (
            <button key={label} type="button" aria-pressed={on} onClick={() => p.set(f, t)}
              className={`min-h-11 rounded-md px-3 text-sm ${on ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>{label}</button>
          );
        })}
      </div>
      {children}
    </div>
  );
}
