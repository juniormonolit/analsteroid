'use client';
// «Отложить до…» (владелец 26.10: «буду строиться весной» — не брак, а скрыть до даты). Пресеты — 1 марта,
// 1 апреля, +3 месяца — или своя дата. Общий для приёмки задачи и разбора отказа.
import { postponePresets } from '../engine/config';

const fieldCls = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base text-[var(--color-text)] sm:text-sm';
const mskToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

export function PostponePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const presets = postponePresets();
  return (
    <div className="flex min-w-0 flex-col gap-1 text-[var(--color-text-secondary)]">
      Скрыть до
      <div className="flex flex-wrap gap-1.5">
        {presets.map(p => (
          <button key={p.label} type="button" onClick={() => onChange(p.value)} aria-pressed={value === p.value}
            className={`min-h-11 rounded-lg border px-3 text-[13px] ${value === p.value ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>
            {p.label}
          </button>
        ))}
        <input type="date" value={value} min={mskToday()} onChange={e => onChange(e.target.value)} aria-label="Своя дата"
          className={`${fieldCls} min-h-11 w-full min-w-0 sm:w-auto sm:flex-1`} />
      </div>
    </div>
  );
}
