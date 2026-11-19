'use client';
// Срок задачи (собрание РОПов 18.11 + Осипов 19.11). Всё — ПО МОСКВЕ, независимо от часового пояса браузера:
// у Осипова браузер/приложение Битрикса в UTC, «на доработку до 16:00» уходило в задачу как 19:00 МСК.
// Нативный datetime-local убран («неудобно выставлять, нет кнопки ОК»): день — кнопками или календарём даты,
// время — кнопками или списком по 30 минут; выбранный срок написан словами.
// Быстрые: «Сегодня» = через час, но не позже 17:50 (позже 17:50 — просто через час);
// «Завтра» / «Послезавтра» — то же время суток, зажатое в 09:00–17:50.
// Значение — строка «YYYY-MM-DDTHH:mm» = московское время; в ISO для API — mskInputToIso.
import { SearchSelect } from '@/components/ui/SearchSelect';

const MSK_MS = 3 * 3600_000;
const LATEST = 17 * 60 + 50;
const EARLIEST = 9 * 60;
const pad = (n: number) => String(n).padStart(2, '0');

/** «Сейчас» по Москве: поля getUTC* = московские дата и время. */
const mskNow = (now = Date.now()) => new Date(now + MSK_MS);
const dayStr = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const hm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const addDays = (day: string, n: number) => dayStr(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000));

/** Строка поля (московское время) → ISO для API. Пусто — undefined. */
export const mskInputToIso = (v: string) => (v ? new Date(`${v}:00+03:00`).toISOString() : undefined);

/** Срок для быстрой кнопки (0 — сегодня, 1 — завтра, 2 — послезавтра), строка поля по Москве. */
export function quickDeadline(daysAhead: 0 | 1 | 2, now = Date.now()): string {
  const m = mskNow(now);
  const today = dayStr(m);
  const nowMin = m.getUTCHours() * 60 + m.getUTCMinutes();
  const inHour = nowMin + 60;
  if (daysAhead === 0) {
    if (nowMin >= LATEST) return inHour >= 24 * 60 ? `${addDays(today, 1)}T${hm(inHour - 24 * 60)}` : `${today}T${hm(inHour)}`;
    return `${today}T${hm(Math.min(inHour, LATEST))}`;
  }
  const t = inHour >= 24 * 60 ? LATEST : Math.max(EARLIEST, Math.min(inHour, LATEST));
  return `${addDays(today, daysAhead)}T${hm(t)}`;
}

const QUICK_DAYS: { days: 0 | 1 | 2; label: string }[] = [
  { days: 0, label: 'Сегодня' }, { days: 1, label: 'Завтра' }, { days: 2, label: 'Послезавтра' },
];
const QUICK_TIMES = ['10:00', '12:00', '14:00', '16:00', '17:50'];
const SLOTS = Array.from({ length: (20 - 8) * 2 + 1 }, (_, i) => hm(8 * 60 + i * 30));

const chip = (on: boolean) => `inline-flex min-h-11 items-center gap-1 rounded-full border px-3 text-[12.5px] sm:min-h-8 ${on
  ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
  : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`;

/** «чт, 20.11 в 16:00» — по Москве. */
function human(v: string) {
  const d = new Date(`${v.slice(0, 10)}T12:00:00Z`);
  const wd = d.toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' });
  return `${wd}, ${v.slice(8, 10)}.${v.slice(5, 7)} в ${v.slice(11, 16)}`;
}

export function DeadlineField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const now = Date.now();
  const today = dayStr(mskNow(now));
  const day = value.slice(0, 10);
  const time = value.slice(11, 16);
  const past = !!value && Date.parse(`${value}:00+03:00`) < now;
  // Время без дня — на сегодня (если уже прошло — на завтра); день без времени — время быстрой кнопки.
  const setTime = (t: string) => {
    if (day) return onChange(`${day}T${t}`);
    const nowHm = hm(mskNow(now).getUTCHours() * 60 + mskNow(now).getUTCMinutes());
    onChange(`${t > nowHm ? today : addDays(today, 1)}T${t}`);
  };
  const setDay = (d: string) => onChange(`${d}T${time || quickDeadline(1, now).slice(11)}`);
  const timeOptions = (time && !SLOTS.includes(time) ? [time, ...SLOTS] : SLOTS).map(t => ({ value: t, label: t }));

  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-[12px] text-[var(--color-text-muted)]">
      <span>{label} <span className="opacity-80">· время московское</span></span>
      <div className="flex flex-wrap gap-1.5">
        {QUICK_DAYS.map(q => {
          const v = quickDeadline(q.days, now);
          const on = value === v;
          return (
            <button key={q.days} type="button" onClick={() => onChange(on ? '' : v)} aria-pressed={on} className={chip(on)}>
              {q.label} <span className={on ? 'opacity-80' : 'text-[var(--color-text-muted)]'}>{q.days === 0 ? v.slice(11) : `${v.slice(8, 10)}.${v.slice(5, 7)} ${v.slice(11)}`}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-full sm:w-auto">Время:</span>
        {QUICK_TIMES.map(t => (
          <button key={t} type="button" onClick={() => setTime(t)} aria-pressed={time === t} className={chip(time === t)}>{t}</button>
        ))}
        <SearchSelect options={timeOptions} value={time && !QUICK_TIMES.includes(time) ? time : ''} onChange={v => v && setTime(v)}
          placeholder="другое" ariaLabel="Другое время" className="min-h-11 sm:min-h-8" />
      </div>
      <label className="flex flex-wrap items-center gap-1.5">
        <span>Другой день:</span>
        {/* Только дата: календарь закрывается по клику на день, кнопка «ОК» не нужна. */}
        <input type="date" value={day} min={today} onChange={e => e.target.value && setDay(e.target.value)}
          className="min-h-11 min-w-0 rounded-md border border-[var(--color-border)] bg-transparent px-2.5 text-base text-[var(--color-text)] sm:min-h-8 sm:text-sm" />
      </label>
      {value && (
        <div className={`flex flex-wrap items-center gap-2 text-[13px] ${past ? 'text-[var(--color-negative)]' : 'text-[var(--color-text)]'}`}>
          <span>Срок: <b>{human(value)}</b> (МСК){past ? ' — уже прошло, выберите позже' : ''}</span>
          <button type="button" onClick={() => onChange('')} className="tap-target text-[12px] text-[var(--color-text-muted)] underline">сбросить</button>
        </div>
      )}
    </div>
  );
}
