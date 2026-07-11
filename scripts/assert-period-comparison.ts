/**
 * Assert-скрипт: календарная семантика сравнения для быстрых пресетов (задача
 * владельца 10.07, дословно — «При выборе периода быстрыми кнопками типа
 * "прошлый месяц" сравнительный должен не хвостик подгружать, а тоже месяц»).
 *
 * Импортирует РЕАЛЬНЫЙ код lib/period/index.ts напрямую (Node type-stripping,
 * без сборки/ts-node) — проверяем то, что реально исполняется в приложении, а не
 * копию логики.
 *
 * Запуск: node --experimental-strip-types scripts/assert-period-comparison.ts
 * (не завязан на npm-скрипты — предупреждение Node про experimental type
 * stripping в stderr ожидаемо и не является ошибкой).
 */
import { toZonedTime } from 'date-fns-tz';
import {
  startOfMonth, endOfMonth, startOfQuarter, endOfQuarter, startOfYear, endOfYear,
  startOfWeek, endOfWeek, subMonths, subQuarters, subYears, subWeeks, subDays,
  differenceInCalendarDays, isSameDay,
} from 'date-fns';
import {
  calendarUnitBounds, previousCalendarUnitBounds, calendarComparisonForPreset,
  applyPreset, defaultPeriod, defaultComparison, recomputeComparison, previousPeriodSameLength,
  type DateRange, type CalendarUnit,
} from '../lib/period/index.ts';

const TZ = 'Europe/Moscow';
let failures = 0;
let passed = 0;

function eqDate(a: Date, b: Date, label: string) {
  if (a.getTime() !== b.getTime()) {
    failures++;
    console.error(`FAIL ${label}: expected ${b.toISOString()}, got ${a.toISOString()}`);
  } else {
    passed++;
  }
}

function eqRange(actual: DateRange, expected: DateRange, label: string) {
  eqDate(actual.from, expected.from, `${label} .from`);
  eqDate(actual.to, expected.to, `${label} .to`);
}

function check(cond: boolean, label: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    passed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Чистая календарная арифметика (фиксированные ref-даты, не зависит от
//    реального «сейчас» — детерминированно в любой момент запуска).
// ─────────────────────────────────────────────────────────────────────────────

// Границы месяца — обычный случай (июнь → границы июня)
{
  const ref = new Date(2026, 5, 15); // 15 июня 2026
  const b = calendarUnitBounds('month', ref);
  check(b.from.getFullYear() === 2026 && b.from.getMonth() === 5 && b.from.getDate() === 1, 'calendarUnitBounds month: from = 1 июня');
  check(b.to.getFullYear() === 2026 && b.to.getMonth() === 5 && b.to.getDate() === 30, 'calendarUnitBounds month: to = 30 июня (последний день)');
}

// Предыдущий месяц — пример владельца: июнь → май ЦЕЛИКОМ (1-31 мая)
{
  const ref = new Date(2026, 5, 15); // любая дата внутри июня
  const prev = previousCalendarUnitBounds('month', ref);
  check(prev.from.getFullYear() === 2026 && prev.from.getMonth() === 4 && prev.from.getDate() === 1, 'previousCalendarUnitBounds month (июнь→май): from = 1 мая');
  check(prev.to.getFullYear() === 2026 && prev.to.getMonth() === 4 && prev.to.getDate() === 31, 'previousCalendarUnitBounds month (июнь→май): to = 31 мая');
  check(prev.to.getHours() === 23 && prev.to.getMinutes() === 59, 'previousCalendarUnitBounds month: to = конец дня (23:59)');
}

// Год назад через границу января (март 2026 → предыдущий месяц = февраль 2026, В ДРУГОМ месяце)
{
  const ref = new Date(2026, 2, 5); // 5 марта 2026
  const prev = previousCalendarUnitBounds('month', ref);
  check(prev.from.getFullYear() === 2026 && prev.from.getMonth() === 1 && prev.from.getDate() === 1, 'previousCalendarUnitBounds month (март→февраль): from = 1 февраля');
  check(prev.to.getDate() === 28, 'previousCalendarUnitBounds month (март 2026, невисокосный): февраль = 28 дней');
}

// Январь → предыдущий месяц = декабрь ПРЕДЫДУЩЕГО ГОДА (год rollover)
{
  const ref = new Date(2026, 0, 15); // 15 января 2026
  const prev = previousCalendarUnitBounds('month', ref);
  check(prev.from.getFullYear() === 2025 && prev.from.getMonth() === 11 && prev.from.getDate() === 1, 'previousCalendarUnitBounds month (январь→декабрь пред. года): from = 1 дек 2025');
  check(prev.to.getFullYear() === 2025 && prev.to.getMonth() === 11 && prev.to.getDate() === 31, 'previousCalendarUnitBounds month (январь→декабрь пред. года): to = 31 дек 2025');
}

// Високосный февраль: март 2028 (год ВЫСОКОСНЫЙ) → февраль = 29 дней
{
  const ref = new Date(2028, 2, 10); // март 2028
  const prev = previousCalendarUnitBounds('month', ref);
  check(prev.from.getMonth() === 1 && prev.from.getFullYear() === 2028, 'leap: предыдущий месяц = февраль 2028');
  check(prev.to.getDate() === 29, 'leap: февраль 2028 (високосный) = 29 дней');
}
// Невисокосный февраль для контраста: март 2027 → февраль = 28 дней
{
  const ref = new Date(2027, 2, 10);
  const prev = previousCalendarUnitBounds('month', ref);
  check(prev.to.getDate() === 28, 'non-leap: февраль 2027 = 28 дней');
}
// Век без високосности (2100 НЕ високосный, хотя делится на 4) — край date-fns/JS Date
{
  const ref = new Date(2100, 2, 10);
  const prev = previousCalendarUnitBounds('month', ref);
  check(prev.to.getDate() === 28, 'century rule: февраль 2100 (не високосный) = 28 дней');
}

// Неделя: границы пн-вс, ref — среда
{
  const ref = new Date(2026, 6, 8); // среда, 8 июля 2026
  check(ref.getDay() === 3, 'sanity: 8 июля 2026 — среда');
  const b = calendarUnitBounds('week', ref);
  check(b.from.getDay() === 1, 'calendarUnitBounds week: from = понедельник');
  check(b.to.getDay() === 0, 'calendarUnitBounds week: to = воскресенье');
  check(b.from.getDate() === 6 && b.from.getMonth() === 6, 'calendarUnitBounds week: неделя 6-12 июля → from = 6 июля');
  check(b.to.getDate() === 12, 'calendarUnitBounds week: to = 12 июля');
}
// Предыдущая неделя — ровно на 7 дней раньше, тоже пн-вс
{
  const ref = new Date(2026, 6, 8); // среда 8 июля 2026 (неделя 6-12 июля)
  const cur = calendarUnitBounds('week', ref);
  const prev = previousCalendarUnitBounds('week', ref);
  check(prev.from.getDay() === 1 && prev.to.getDay() === 0, 'previousCalendarUnitBounds week: тоже пн-вс');
  check(differenceInCalendarDays(cur.from, prev.from) === 7, 'previousCalendarUnitBounds week: ровно на 7 дней раньше текущей недели');
}
// Неделя через границу месяца/года (среда 31.12.2025 — неделя 29.12.2025-04.01.2026)
{
  const ref = new Date(2025, 11, 31);
  const b = calendarUnitBounds('week', ref);
  check(b.from.getFullYear() === 2025 && b.from.getMonth() === 11 && b.from.getDate() === 29, 'week через год: from = 29 дек 2025 (пн)');
  check(b.to.getFullYear() === 2026 && b.to.getMonth() === 0 && b.to.getDate() === 4, 'week через год: to = 4 янв 2026 (вс)');
}

// Квартал: обычный (апрель → Q2), предыдущий квартал = Q1 того же года
{
  const ref = new Date(2026, 3, 15); // апрель 2026 (Q2)
  const prev = previousCalendarUnitBounds('quarter', ref);
  check(prev.from.getFullYear() === 2026 && prev.from.getMonth() === 0 && prev.from.getDate() === 1, 'quarter Q2→Q1: from = 1 янв 2026');
  check(prev.to.getFullYear() === 2026 && prev.to.getMonth() === 2 && prev.to.getDate() === 31, 'quarter Q2→Q1: to = 31 мар 2026');
}
// Квартал через год: январь (Q1) → предыдущий квартал = Q4 ПРЕДЫДУЩЕГО года
{
  const ref = new Date(2026, 1, 10); // февраль 2026 (Q1)
  const prev = previousCalendarUnitBounds('quarter', ref);
  check(prev.from.getFullYear() === 2025 && prev.from.getMonth() === 9 && prev.from.getDate() === 1, 'quarter Q1→Q4 пред. года: from = 1 окт 2025');
  check(prev.to.getFullYear() === 2025 && prev.to.getMonth() === 11 && prev.to.getDate() === 31, 'quarter Q1→Q4 пред. года: to = 31 дек 2025');
}

// Год: 2026 → предыдущий год 2025 целиком
{
  const ref = new Date(2026, 5, 15);
  const prev = previousCalendarUnitBounds('year', ref);
  check(prev.from.getFullYear() === 2025 && prev.from.getMonth() === 0 && prev.from.getDate() === 1, 'year: from = 1 янв 2025');
  check(prev.to.getFullYear() === 2025 && prev.to.getMonth() === 11 && prev.to.getDate() === 31, 'year: to = 31 дек 2025');
}
// Високосный год целиком (2028) как ref — предыдущий год 2027 (не високосный, 365 дней)
{
  const ref = new Date(2028, 5, 15);
  const prev = previousCalendarUnitBounds('year', ref);
  const days = differenceInCalendarDays(prev.to, prev.from) + 1;
  check(days === 365, 'year: 2027 (не високосный) = 365 дней');
}

// ─────────────────────────────────────────────────────────────────────────────
// B. calendarComparisonForPreset — реальная «сейчас» (МСК), как в приложении.
//    Ожидания строятся НЕЗАВИСИМО через date-fns на том же mskNow, а не хардкодом
//    даты — тест детерминирован в любой день запуска.
// ─────────────────────────────────────────────────────────────────────────────
const mskNow = toZonedTime(new Date(), TZ);

function expectCalendar(unit: CalendarUnit, anchor: Date): DateRange {
  const prevAnchorUnit: Record<CalendarUnit, (d: Date) => Date> = {
    day: d => subDays(d, 1), week: d => subWeeks(d, 1), month: d => subMonths(d, 1),
    quarter: d => subQuarters(d, 1), year: d => subYears(d, 1),
  };
  const prevAnchor = prevAnchorUnit[unit](anchor);
  const boundsFn: Record<CalendarUnit, (d: Date) => DateRange> = {
    day: d => ({ from: d, to: d }), // не используется здесь напрямую для day/week/month — see below
    week: d => ({ from: startOfWeek(d, { weekStartsOn: 1 }), to: endOfWeek(d, { weekStartsOn: 1 }) }),
    month: d => ({ from: startOfMonth(d), to: endOfMonth(d) }),
    quarter: d => ({ from: startOfQuarter(d), to: endOfQuarter(d) }),
    year: d => ({ from: startOfYear(d), to: endOfYear(d) }),
  };
  return boundsFn[unit](prevAnchor);
}

// today → сравнение = вчера, целый день
{
  const yesterday = subDays(mskNow, 1);
  const actual = calendarComparisonForPreset('today');
  check(isSameDay(actual.from, yesterday) && isSameDay(actual.to, yesterday), 'calendarComparisonForPreset(today) = вчера целиком');
  check(actual.from.getHours() === 0 && actual.to.getHours() === 23, 'calendarComparisonForPreset(today): полный день (00:00-23:59)');
}
// yesterday → сравнение = позавчера
{
  const dayBeforeYesterday = subDays(mskNow, 2);
  const actual = calendarComparisonForPreset('yesterday');
  check(isSameDay(actual.from, dayBeforeYesterday) && isSameDay(actual.to, dayBeforeYesterday), 'calendarComparisonForPreset(yesterday) = позавчера целиком');
}
// this_week → сравнение = прошлая календарная неделя (пн-вс)
{
  const expected = expectCalendar('week', mskNow);
  eqRange(calendarComparisonForPreset('this_week'), expected, 'calendarComparisonForPreset(this_week) = прошлая неделя пн-вс');
}
// last_week → сравнение = позапрошлая неделя
{
  const lastWeekAnchor = subDays(startOfWeek(mskNow, { weekStartsOn: 1 }), 1);
  const expected = expectCalendar('week', lastWeekAnchor);
  eqRange(calendarComparisonForPreset('last_week'), expected, 'calendarComparisonForPreset(last_week) = позапрошлая неделя');
}
// this_month → сравнение = ПОЛНЫЙ предыдущий месяц (даже если период частичный/capped по сегодня)
{
  const expected = expectCalendar('month', mskNow);
  eqRange(calendarComparisonForPreset('this_month'), expected, 'calendarComparisonForPreset(this_month) = предыдущий месяц целиком');
  // period ("этот месяц") — частичный (capped по сегодня), но сравнение НЕ обрезано
  const period = applyPreset('this_month');
  const cmp = calendarComparisonForPreset('this_month');
  check(cmp.to.getDate() === endOfMonth(subMonths(mskNow, 1)).getDate(), 'this_month: сравнение — ПОЛНЫЙ месяц, не урезано вслед за частичным периодом');
  void period;
}
// last_month → сравнение = месяц ДО прошлого месяца (позапрошлый целиком)
{
  const lastMonthAnchor = subMonths(mskNow, 1);
  const expected = expectCalendar('month', lastMonthAnchor);
  eqRange(calendarComparisonForPreset('last_month'), expected, 'calendarComparisonForPreset(last_month) = позапрошлый месяц целиком');
}

// ─────────────────────────────────────────────────────────────────────────────
// C. Пример владельца дословно: если СЕГОДНЯ реально попадает в июль (как в этой
//    сессии, 2026-07-10), applyPreset('last_month') должен резолвить период в
//    ИЮНЬ, а calendarComparisonForPreset('last_month') — в МАЙ целиком.
//    Если тест запускается в другом месяце, блок просто печатает инфо и не падает
//    (не хардкодим месяц запуска в критерий провала — это demo/sanity, а не
//    единственная проверка семантики: она уже покрыта детерминированными тестами
//    выше через фиксированные ref-даты).
// ─────────────────────────────────────────────────────────────────────────────
{
  const period = applyPreset('last_month');
  const comparison = calendarComparisonForPreset('last_month');
  // ВАЖНО: period/comparison — это msk()-датированные значения (см. lib/period::msk()),
  // читать компоненты только ЛОКАЛЬНЫМИ геттерами (getMonth/getDate), НЕ UTC-геттерами
  // (getUTCMonth и т.п. дают день по UTC, который у полуночи МСК — предыдущие сутки).
  console.log(`[инфо] applyPreset('last_month') сейчас резолвит период ${period.from.getFullYear()}-${period.from.getMonth() + 1}-${period.from.getDate()}..${period.to.getFullYear()}-${period.to.getMonth() + 1}-${period.to.getDate()}, сравнение ${comparison.from.getFullYear()}-${comparison.from.getMonth() + 1}-${comparison.from.getDate()}..${comparison.to.getFullYear()}-${comparison.to.getMonth() + 1}-${comparison.to.getDate()}`);
  if (period.from.getMonth() === 5 && period.from.getFullYear() === 2026) {
    check(comparison.from.getMonth() === 4 && comparison.from.getDate() === 1, "пример владельца: период=июнь 2026 → сравнение начинается 1 мая");
    check(comparison.to.getMonth() === 4 && comparison.to.getDate() === 31, "пример владельца: сравнение заканчивается 31 мая (целиком, не хвост)");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// D. Регресс: РУЧНОЙ диапазон (recomputeComparison/previousPeriodSameLength) —
//    поведение НЕ должно измениться этой задачей (обе функции не тронуты).
// ─────────────────────────────────────────────────────────────────────────────
{
  const manual: DateRange = { from: new Date(2026, 5, 10), to: new Date(2026, 5, 14) }; // 10-14 июня, 5 дней
  const tail = recomputeComparison(manual);
  const days = differenceInCalendarDays(tail.to, tail.from) + 1;
  check(days === 5, 'recomputeComparison: ручной диапазон — хвост ТОЙ ЖЕ длины (5 дней)');
  check(tail.to.getMonth() === 4 && tail.to.getDate() === 31, 'recomputeComparison: хвост заканчивается последним днём предыдущего месяца (не поменяли)');

  const adjacent = previousPeriodSameLength(manual);
  const adjDays = differenceInCalendarDays(adjacent.to, adjacent.from) + 1;
  check(adjDays === 5, 'previousPeriodSameLength: та же длина (5 дней)');
  check(isSameDay(adjacent.to, subDays(manual.from, 1)), 'previousPeriodSameLength: заканчивается ровно перед стартом периода (не поменяли)');
}

// ─────────────────────────────────────────────────────────────────────────────
// E. defaultComparison() — дефолт НОВОГО отчёта (задача 1666, регрессия f9d69d4):
//    предыдущий период ТОЙ ЖЕ ДЛИНЫ, вплотную к началу period, а НЕ календарный
//    «весь предыдущий месяц» (это семантика явного клика по пресету, см. блок B —
//    calendarComparisonForPreset намеренно НЕ трогаем и не путаем с дефолтом).
// ─────────────────────────────────────────────────────────────────────────────
{
  const period = defaultPeriod();
  const comparison = defaultComparison();
  const expected = recomputeComparison(period);
  eqRange(comparison, expected, 'defaultComparison() === recomputeComparison(defaultPeriod()) — та же длина, не календарный месяц');

  const days = differenceInCalendarDays(period.to, period.from) + 1;
  const compDays = differenceInCalendarDays(comparison.to, comparison.from) + 1;
  check(compDays === days, `defaultComparison(): длина сравнения (${compDays}) равна длине периода (${days})`);
  check(isSameDay(comparison.to, subDays(period.from, 1)), 'defaultComparison(): сравнение заканчивается вплотную перед началом периода');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
