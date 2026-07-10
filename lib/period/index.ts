import {
  startOfMonth, endOfMonth, subDays, subMonths, subWeeks, subQuarters, subYears,
  startOfWeek, endOfWeek, startOfQuarter, endOfQuarter, startOfYear, endOfYear,
  startOfDay, endOfDay, isSameDay,
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

/**
 * Дефолтный период СРАВНЕНИЯ для defaultPeriod() (первая загрузка отчёта без
 * сохранённого пресета — by-managers/by-product-groups/marketing). defaultPeriod()
 * по конструкции ВСЕГДА календарный объект — «этот месяц» (обрезан по вчера) либо,
 * 1-го числа, «прошлый месяц целиком» — поэтому сравнение тоже должно быть
 * календарным (задача 10.07), а не хвостом (см. calendarComparisonForPreset). Не
 * принимает DateRange (в отличие от recomputeComparison/previousPeriodSameLength) —
 * специально пересчитывает «какой сейчас день» сама, той же веткой, что и
 * defaultPeriod(), чтобы не расходиться при вызове порознь.
 */
export function defaultComparison(): DateRange {
  const today = msk();
  const isFirst = today.getDate() === 1;
  return calendarComparisonForPreset(isFirst ? 'last_month' : 'this_month');
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

// ── Календарная семантика сравнения для БЫСТРЫХ ПРЕСЕТОВ ────────────────────
// Задача владельца 10.07 (дословно): «При выборе периода быстрыми кнопками типа
// "прошлый месяц" сравнительный должен не хвостик подгружать, а тоже месяц».
// recomputeComparison/previousPeriodSameLength выше — оба «хвостовые» (тот же
// метраж дней), это ОСТАЁТСЯ поведением для РУЧНОГО выбора диапазона в календаре
// (два клика по дням). Для пресета с календарной семантикой (день/неделя/месяц)
// сравнение должно быть ТЕМ ЖЕ типом календарного объекта на шаг назад — сравнить
// объекты, а не отрезки одинаковой длины.
export type CalendarUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

/** Границы календарного объекта (пн-вс для недели), содержащего `ref`. */
export function calendarUnitBounds(unit: CalendarUnit, ref: Date): DateRange {
  switch (unit) {
    case 'day':     return { from: startOfDay(ref),     to: endOfDay(ref) };
    case 'week':    return { from: startOfWeek(ref, { weekStartsOn: 1 }), to: endOfWeek(ref, { weekStartsOn: 1 }) };
    case 'month':   return { from: startOfMonth(ref),   to: endOfMonth(ref) };
    case 'quarter': return { from: startOfQuarter(ref), to: endOfQuarter(ref) };
    case 'year':    return { from: startOfYear(ref),    to: endOfYear(ref) };
  }
}

function shiftCalendarUnitBack(ref: Date, unit: CalendarUnit): Date {
  switch (unit) {
    case 'day':     return subDays(ref, 1);
    case 'week':    return subWeeks(ref, 1);
    case 'month':   return subMonths(ref, 1);
    case 'quarter': return subQuarters(ref, 1);
    case 'year':    return subYears(ref, 1);
  }
}

/** Границы календарного объекта ТОГО ЖЕ типа, на один шаг раньше объекта,
 *  содержащего `ref` (например unit='month', ref=15 марта → весь февраль). Чистая
 *  функция от `ref`+`unit` — без обращения к «сейчас», поэтому легко тестируется
 *  на границах месяцев/кварталов/года и високосном феврале (см. assert-скрипт). */
export function previousCalendarUnitBounds(unit: CalendarUnit, ref: Date): DateRange {
  return calendarUnitBounds(unit, shiftCalendarUnitBack(ref, unit));
}

// Каждому быстрому пресету — его календарный тип объекта + «якорная» дата ВНУТРИ
// объекта, которую описывает пресет (не сам DateRange пресета — у this_month/today
// правая граница обрезана по вчера/сегодня, а для определения ПРЕДЫДУЩЕГО
// календарного объекта важен именно тип периода, а не его фактические границы).
const PRESET_UNIT: Record<PresetKey, CalendarUnit> = {
  today: 'day', yesterday: 'day',
  this_week: 'week', last_week: 'week',
  this_month: 'month', last_month: 'month',
};

function presetAnchorDate(key: PresetKey, today: Date): Date {
  switch (key) {
    case 'today':      return today;
    case 'yesterday':  return subDays(today, 1);
    case 'this_week':  return today;
    // тот же ориентир, что и в applyPreset('last_week') — любая дата ВНУТРИ прошлой недели
    case 'last_week':  return subDays(startOfWeek(today, { weekStartsOn: 1 }), 1);
    case 'this_month': return today;
    case 'last_month': return subMonths(today, 1);
  }
}

/**
 * Период сравнения для БЫСТРОГО ПРЕСЕТА (задача 10.07 — календарная семантика вместо
 * хвоста): предыдущий календарный объект ТОГО ЖЕ ТИПА. «Этот месяц»/«прошлый месяц» →
 * июнь → сравнение май ЦЕЛИКОМ (1-31 мая), а не хвост той же длины. Решение по
 * частичному «этот месяц» (период обрезан по вчера): сравнение ВСЁ РАВНО полный
 * предыдущий месяц (консистентно с «прошлый месяц» — Серёга проверяет руками, см.
 * WORKLOG). Квартал/год пока не в UI пресетов (кнопок нет, см. PresetKey) — движок
 * (calendarUnitBounds/previousCalendarUnitBounds) уже общий, добавление кнопок в
 * будущем не потребует новой логики сравнения.
 */
export function calendarComparisonForPreset(key: PresetKey): DateRange {
  const today = msk();
  const unit = PRESET_UNIT[key];
  const anchor = presetAnchorDate(key, today);
  return previousCalendarUnitBounds(unit, anchor);
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
