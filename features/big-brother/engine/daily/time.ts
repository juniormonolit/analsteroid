// «Большой брат», поток D — даты МСК (UTC+3 без летнего времени, как в lib/bots/idleWatch.ts).
import { isWorkingDayJs } from '@/lib/metrics/productionCalendar';

export const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** Дата МСК YYYY-MM-DD момента at. */
export function mskDate(at: Date | number = Date.now()): string {
  return new Date(+at + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Начало дня МСК (00:00) + hour часов. */
export function mskAt(date: string, hour = 0): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) - MSK_OFFSET_MS + hour * 3600_000);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function isValidDate(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
}

/** Рабочий день по производственному календарю. */
export function isWorkday(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  return isWorkingDayJs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), dow === 0 ? 7 : dow);
}

/** Границы дня МСК: [from, to), to для сегодняшнего дня — сейчас. */
export function dayBounds(date: string, now = Date.now()): { from: Date; to: Date; asOf: Date } {
  const from = mskAt(date);
  const end = new Date(from.getTime() + DAY_MS);
  const to = end.getTime() > now ? new Date(now) : end;
  return { from, to: end, asOf: to };
}
