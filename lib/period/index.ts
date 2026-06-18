import {
  startOfMonth, endOfDay, subDays, subMonths,
  startOfWeek, endOfWeek, startOfDay, isSameDay,
  differenceInCalendarDays, addDays,
} from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

const TZ = 'Europe/Moscow';

export interface DateRange {
  from: Date;
  to: Date;
}

export interface PeriodState {
  current: DateRange;
  comparison: DateRange;
}

function msk(): Date {
  return toZonedTime(new Date(), TZ);
}

export function defaultPeriod(): DateRange {
  const today = msk();
  const isFirst = today.getDate() === 1;
  if (isFirst) {
    const prevMonth = subMonths(today, 1);
    return {
      from: startOfMonth(prevMonth),
      to: endOfDay(subDays(today, 1)),
    };
  }
  return {
    from: startOfMonth(today),
    to: endOfDay(subDays(today, 1)),
  };
}

/** Same-length tail of the previous month */
export function recomputeComparison(current: DateRange): DateRange {
  const len = differenceInCalendarDays(current.to, current.from) + 1;
  const compTo = subDays(startOfMonth(current.from), 1); // last day of prev month
  const compFrom = subDays(addDays(compTo, 1), len);     // len days ending at compTo
  return { from: startOfDay(compFrom), to: endOfDay(compTo) };
}

export type PresetKey =
  | 'today' | 'yesterday' | 'this_week' | 'last_week'
  | 'this_month' | 'last_month';

export function applyPreset(key: PresetKey): DateRange {
  const today = msk();
  switch (key) {
    case 'today':
      return { from: startOfDay(today), to: endOfDay(today) };
    case 'yesterday': {
      const y = subDays(today, 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case 'this_week':
      return { from: startOfWeek(today, { weekStartsOn: 1 }), to: endOfDay(today) };
    case 'last_week': {
      const lw = subDays(startOfWeek(today, { weekStartsOn: 1 }), 1);
      return { from: startOfWeek(lw, { weekStartsOn: 1 }), to: endOfWeek(lw, { weekStartsOn: 1 }) };
    }
    case 'this_month':
      return { from: startOfMonth(today), to: endOfDay(today) };
    case 'last_month': {
      const lm = subMonths(today, 1);
      return { from: startOfMonth(lm), to: endOfDay(subDays(startOfMonth(today), 1)) };
    }
  }
}

/** Convert DateRange to UTC ISO strings for SQL half-open interval [from, toExcl) */
export function toSqlInterval(range: DateRange): { from: string; toExcl: string } {
  return {
    from: range.from.toISOString(),
    toExcl: addDays(endOfDay(range.to), 0).toISOString(), // to+1day 00:00
  };
}

export const PRESET_LABELS: Record<PresetKey, string> = {
  today: 'Сегодня',
  yesterday: 'Вчера',
  this_week: 'Эта неделя',
  last_week: 'Прошлая неделя',
  this_month: 'Этот месяц',
  last_month: 'Прошлый месяц',
};
