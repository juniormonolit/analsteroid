'use client';
// Срок задачи с быстрыми кнопками (собрание РОПов 18.11): «Сегодня / Завтра / Послезавтра» — РОП почти всегда
// ставит сегодня или завтра. Бесило, что дела встают на 19:00 (после рабочего дня) — поэтому:
// «Сегодня» = через час, но не позже 17:50 (уже позже 17:50 — просто через час);
// «Завтра» / «Послезавтра» — то же время суток (через час от сейчас), зажатое в 09:00–17:50.
// Значение — строка datetime-local (локальное время браузера), как у прежнего голого инпута.

const LATEST = { h: 17, m: 50 };
const EARLIEST = { h: 9, m: 0 };

const pad = (n: number) => String(n).padStart(2, '0');
export const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Срок для быстрой кнопки: 0 — сегодня, 1 — завтра, 2 — послезавтра. */
export function quickDeadline(daysAhead: 0 | 1 | 2, now = new Date()): Date {
  const inHour = new Date(now.getTime() + 60 * 60_000);
  inHour.setSeconds(0, 0);
  const latest = new Date(now); latest.setHours(LATEST.h, LATEST.m, 0, 0);
  if (daysAhead === 0) {
    if (now >= latest) return inHour;
    return inHour > latest ? latest : inHour;
  }
  const d = new Date(now); d.setDate(d.getDate() + daysAhead);
  let h = inHour.getHours(), m = inHour.getMinutes();
  if (inHour.getDate() !== now.getDate()) { h = LATEST.h; m = LATEST.m; } // «через час» уже завтра — значит поздний вечер
  if (h * 60 + m > LATEST.h * 60 + LATEST.m) { h = LATEST.h; m = LATEST.m; }
  if (h * 60 + m < EARLIEST.h * 60 + EARLIEST.m) { h = EARLIEST.h; m = EARLIEST.m; }
  d.setHours(h, m, 0, 0);
  return d;
}

const QUICK: { days: 0 | 1 | 2; label: string }[] = [
  { days: 0, label: 'Сегодня' }, { days: 1, label: 'Завтра' }, { days: 2, label: 'Послезавтра' },
];

const input = 'w-full min-w-0 rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-2 text-base sm:text-sm';

export function DeadlineField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const fmt = (d: Date) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)]">
      <span>{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {QUICK.map(q => {
          const d = quickDeadline(q.days);
          const v = toLocalInput(d);
          const on = value === v;
          return (
            <button key={q.days} type="button" onClick={() => onChange(on ? '' : v)} aria-pressed={on}
              className={`inline-flex min-h-11 items-center gap-1 rounded-full border px-3 text-[12.5px] sm:min-h-8 ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
              {q.label} <span className={on ? 'opacity-80' : 'text-[var(--color-text-muted)]'}>{q.days === 0 ? fmt(d) : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${fmt(d)}`}</span>
            </button>
          );
        })}
      </div>
      <input type="datetime-local" value={value} onChange={e => onChange(e.target.value)} className={input} aria-label={label} />
    </div>
  );
}
