// Время обучений — всегда МСК (компания в Москве; браузер может стоять в другом поясе).
const TZ = 'Europe/Moscow';

const dayFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const timeFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD в МСК */
export const mskDateKey = (iso: string | Date) => keyFmt.format(new Date(iso));
/** HH:MM в МСК */
export const mskTime = (iso: string | Date) => timeFmt.format(new Date(iso));
export const mskDayLabel = (iso: string | Date) => {
  const s = dayFmt.format(new Date(iso));
  return s.charAt(0).toUpperCase() + s.slice(1);
};
export const endOf = (iso: string, durationMin: number) => new Date(new Date(iso).getTime() + durationMin * 60_000);

/** Дата и время из полей формы (МСК, без перехода на летнее) → ISO. */
export const mskToIso = (date: string, time: string) => new Date(`${date}T${time}:00+03:00`).toISOString();

export const addDaysKey = (key: string, days: number) => {
  const d = new Date(`${key}T12:00:00+03:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return mskDateKey(d);
};

export function durationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export const isUrl = (s: string | null | undefined) => !!s && /^https?:\/\//i.test(s.trim());

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

type MetricFormat = 'percent' | 'money' | 'number';

/** Значение показателя (как fmtValue ядра). */
export function fmtMetric(v: number | null | undefined, format: MetricFormat): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (format === 'percent') return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
  if (format === 'money') return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

/** Изменение «после − до»: проценты — в п.п., со знаком. */
export function fmtDelta(d: number | null | undefined, format: MetricFormat): string {
  if (d === null || d === undefined || !Number.isFinite(d)) return '—';
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  const a = Math.abs(d);
  if (format === 'percent') return `${sign}${a.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} п.п.`;
  if (format === 'money') return `${sign}${Math.round(a).toLocaleString('ru-RU')} ₽`;
  return `${sign}${a.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}`;
}

/** Цвет изменения с учётом направления показателя. */
export function deltaTone(d: number | null | undefined, higherIsBetter: boolean): string {
  if (d === null || d === undefined || !Number.isFinite(d) || d === 0) return 'text-[var(--color-text-muted)]';
  return (d > 0) === higherIsBetter ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]';
}

export const fmtShortDate = (ymd: string) => ymd.split('-').reverse().slice(0, 2).join('.');
