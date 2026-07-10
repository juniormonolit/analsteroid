import {
  startOfMonth, subDays, subMonths,
  startOfWeek, endOfWeek, startOfDay, endOfDay, isSameDay,
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

/**
 * Период той же длины, НЕПОСРЕДСТВЕННО предшествующий текущему — карточка
 * менеджера (задача 10.07, п.3: «фильтры как в отчёте», дефолт периода сравнения
 * = «предыдущий период той же длины»). НЕ путать с recomputeComparison выше
 * («хвост предыдущего МЕСЯЦА» — семантика основного отчёта, другая): здесь окно
 * строго примыкающее, без привязки к границе месяца. Извлечено из
 * features/manager-card/engine/managerCard.ts::previousPeriod (сервер) — общий
 * pure-хелпер, чтобы клиентский ManagerCardPanel.tsx мог посчитать ТОТ ЖЕ дефолт
 * сам (без импорта серверного движка с systemDb/analyticsDb в клиентский бандл).
 */
export function previousPeriodSameLength(current: DateRange): DateRange {
  const days = differenceInCalendarDays(current.to, current.from) + 1;
  const to = startOfDay(subDays(current.from, 1));
  const from = startOfDay(subDays(to, days - 1));
  return { from, to };
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
    toExcl: addDays(startOfDay(range.to), 1).toISOString(),
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
