'use client';

// Время срока задачи (19.11, РОП: «ебота со временем, неудобно выставлять, нет кнопки ОК — отправил на 16, а в задаче 19»).
// Вместо нативного <input type="time"> (на каждом устройстве свой, на части — без «ОК», значение не применялось):
// частые часы кнопками + «другое» из списка с поиском по 15 минут. Значение применяется сразу по нажатию.

import { SearchSelect } from '@/components/ui/SearchSelect';

const PRESETS = ['10:00', '12:00', '14:00', '16:00', '18:00', '19:00'];
const ALL: { value: string; label: string }[] = [];
for (let h = 7; h <= 22; h++) for (const m of ['00', '15', '30', '45']) {
  const v = `${String(h).padStart(2, '0')}:${m}`;
  ALL.push({ value: v, label: v });
}

const CHIP = 'inline-flex min-h-11 items-center justify-center rounded-lg border px-2 text-sm tabular-nums';
const IDLE = `${CHIP} border-[var(--color-border)] bg-[var(--color-bg-surface)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`;
const ACTIVE = `${CHIP} border-[var(--color-accent)] bg-[var(--color-accent)] text-white`;

/** Сегодня по МСК, если время ещё не прошло (с запасом 15 мин), иначе завтра — дата для времени, выбранного без даты. */
export function dateForTime(time: string): string {
  const now = Date.now();
  const today = new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
  if (new Date(`${today}T${time}:00+03:00`).getTime() > now + 15 * 60_000) return today;
  return new Date(now + 3 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
}

export function TimePicker({ value, onChange, label = 'Время (МСК)' }: { value: string; onChange: (t: string) => void; label?: string }) {
  const custom = !PRESETS.includes(value);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[var(--color-text-secondary)]">{label}</span>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
        {PRESETS.map(t => (
          <button key={t} type="button" aria-pressed={value === t} onClick={() => onChange(t)} className={value === t ? ACTIVE : IDLE}>{t}</button>
        ))}
        <SearchSelect ariaLabel="Другое время" value={custom ? value : ''} onChange={v => v && onChange(v)} options={ALL} searchable
          placeholder="Другое" searchPlaceholder="16:30"
          className={`col-span-3 min-h-11 w-full justify-center sm:col-span-1 ${custom ? '!border-[var(--color-accent)] !bg-[var(--color-accent)] !text-white' : ''}`} />
      </div>
    </div>
  );
}
