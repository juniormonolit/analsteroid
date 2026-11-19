// Рабочее время запросов логистам — методика Панели снабжения (lib/supplyPanel/calc.ts):
// будни 09:00–18:00 МСК без праздников. Часы между двумя моментами — тот же workHours(),
// здесь только перевод Date → «секунды МСК» и обратная операция «дедлайн = старт + N рабочих часов».
import { HOLIDAYS, WORK_FROM, WORK_TO, isoOfDay, weekdayOfDay, workHours } from '@/lib/supplyPanel/calc';

const MSK = 3 * 3600;

/** Date/ISO → секунды «наивного МСК», как ждёт workHours(). */
export function mskSec(d: Date | string | number): number {
  return Math.floor(new Date(d).getTime() / 1000) + MSK;
}
const fromMskSec = (s: number): Date => new Date((s - MSK) * 1000);

const isWorkday = (day: number) => weekdayOfDay(day) < 5 && !HOLIDAYS.has(isoOfDay(day));

/** Рабочие часы между a и b (0, если b ≤ a или чего-то нет). */
export function workHoursBetween(a: Date | string | number | null | undefined, b: Date | string | number | null | undefined): number {
  if (a == null || b == null || a === "") return 0;
  return workHours(mskSec(a), mskSec(b));
}

/** Момент, когда от start пройдёт hours рабочих часов. */
export function addWorkHours(start: Date | string, hours: number): Date {
  let left = Math.max(0, hours) * 3600;
  let t = mskSec(start);
  for (let guard = 0; guard < 4000; guard++) {
    const day = Math.floor(t / 86400);
    const lo = day * 86400 + WORK_FROM * 3600, hi = day * 86400 + WORK_TO * 3600;
    if (isWorkday(day) && t < hi) {
      const from = Math.max(t, lo);
      if (from + left <= hi) return fromMskSec(from + left);
      left -= hi - from;
    }
    t = (day + 1) * 86400;
  }
  return fromMskSec(t);
}

/** Остаток до дедлайна в рабочих часах; отрицательный — просрочка. Округление до 0.01. */
export function workHoursLeft(deadline: Date | string, now: Date | string): number {
  const d = new Date(deadline).getTime(), n = new Date(now).getTime();
  const h = d >= n ? workHoursBetween(n, d) : -workHoursBetween(d, n);
  return Math.round(h * 100) / 100;
}
