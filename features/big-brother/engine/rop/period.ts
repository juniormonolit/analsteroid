// «Большой брат» — период и календарь (общие для рейтинга РОПов и дисциплины задач).
// Период — даты МСК YYYY-MM-DD включительно; по умолчанию последние 30 дней, не глубже 366.
import { formatInTimeZone } from 'date-fns-tz';
import { isWorkingDayJs } from '@/lib/metrics/productionCalendar';

const TZ = 'Europe/Moscow';
const DAY = 86_400_000;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 366;

export interface BbPeriod { from: string; to: string }

export const mskDay = (d: Date | number | string) => formatInTimeZone(new Date(d), TZ, 'yyyy-MM-dd');

const isDay = (v: string | null | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

export function parsePeriod(fromQ: string | null, toQ: string | null, now = Date.now()): BbPeriod {
  const today = mskDay(now);
  let to = isDay(toQ) ? toQ : today;
  if (to > today) to = today;
  const floor = mskDay(Date.parse(`${to}T12:00:00Z`) - (MAX_DAYS - 1) * DAY);
  let from = isDay(fromQ) ? fromQ : mskDay(Date.parse(`${to}T12:00:00Z`) - (DEFAULT_DAYS - 1) * DAY);
  if (from < floor) from = floor;
  if (from > to) from = to;
  return { from, to };
}

/** Границы периода для SQL (timestamptz): [fromIso, toExclIso). */
export function periodBounds(p: BbPeriod): { fromIso: string; toExclIso: string } {
  return { fromIso: `${p.from}T00:00:00+03:00`, toExclIso: `${addDays(p.to, 1)}T00:00:00+03:00` };
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** Все дни периода. */
export function daysOf(p: BbPeriod): string[] {
  const out: string[] = [];
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function isWorkday(day: string): boolean {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return isWorkingDayJs(y, m, d, dow);
}

/** Понедельник недели дня. */
export function weekStart(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return addDays(day, 1 - dow);
}

/**
 * Недели периода, в которых есть хотя бы один рабочий день (по производственному календарю).
 * Неделя, отрезанная краем периода, считается, только если в её куске есть рабочий день.
 */
export function workWeeksOf(p: BbPeriod): string[] {
  const set = new Set<string>();
  for (const d of daysOf(p)) if (isWorkday(d)) set.add(weekStart(d));
  return [...set].sort();
}
