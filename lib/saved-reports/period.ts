import {
  startOfDay, endOfDay,
  startOfWeek, endOfWeek,
  startOfMonth, endOfMonth,
  startOfQuarter, endOfQuarter,
  startOfYear, endOfYear,
  subDays, subWeeks, subMonths, subQuarters, subYears,
  differenceInCalendarDays,
} from 'date-fns';
import type { RelativePeriod, ComparisonMode, PeriodUnit } from './types';
import type { DateRange } from '@/lib/period';

function getUnitBounds(unit: PeriodUnit, ref: Date): { from: Date; to: Date } {
  const weekOpts = { weekStartsOn: 1 as const };
  switch (unit) {
    case 'day':     return { from: startOfDay(ref),     to: endOfDay(ref) };
    case 'week':    return { from: startOfWeek(ref, weekOpts), to: endOfWeek(ref, weekOpts) };
    case 'month':   return { from: startOfMonth(ref),   to: endOfMonth(ref) };
    case 'quarter': return { from: startOfQuarter(ref), to: endOfQuarter(ref) };
    case 'year':    return { from: startOfYear(ref),    to: endOfYear(ref) };
  }
}

function shiftBack(date: Date, unit: PeriodUnit): Date {
  switch (unit) {
    case 'day':     return subDays(date, 1);
    case 'week':    return subWeeks(date, 1);
    case 'month':   return subMonths(date, 1);
    case 'quarter': return subQuarters(date, 1);
    case 'year':    return subYears(date, 1);
  }
}

export function resolveRelativePeriod(rp: RelativePeriod, now = new Date()): DateRange {
  const ref = rp.anchor === 'previous' ? shiftBack(now, rp.unit) : now;
  const bounds = getUnitBounds(rp.unit, ref);
  // Cap 'to' at today so we don't show future dates for current periods
  const to = bounds.to > now ? now : bounds.to;
  return { from: bounds.from, to };
}

export function resolveComparison(
  period: DateRange,
  mode: ComparisonMode,
  rp: RelativePeriod | null,
  now = new Date(),
): DateRange {
  if (mode === 'analogous' && rp) {
    // Same period type, one step further back
    const prevRp: RelativePeriod = {
      anchor: rp.anchor === 'current' ? 'previous' : rp.anchor,
      unit: rp.unit,
    };
    if (rp.anchor === 'previous') {
      // already previous → go two steps back
      const ref = shiftBack(shiftBack(now, rp.unit), rp.unit);
      const bounds = getUnitBounds(rp.unit, ref);
      return { from: bounds.from, to: bounds.to };
    }
    return resolveRelativePeriod(prevRp, now);
  }
  // previous_tail: same number of days immediately before
  const days = differenceInCalendarDays(period.to, period.from) + 1;
  const to = subDays(period.from, 1);
  const from = subDays(to, days - 1);
  return { from, to };
}

export const PERIOD_UNIT_LABELS: Record<string, string> = {
  day: 'День',
  week: 'Неделя',
  month: 'Месяц',
  quarter: 'Квартал',
  year: 'Год',
};

export const PERIOD_ANCHOR_LABELS: Record<string, string> = {
  current: 'Текущий',
  previous: 'Прошлый',
};
