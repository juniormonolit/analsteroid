// Единый источник "рабочих дней" для расчёта дневного плана — п.7 согласованной
// спеки (решение собрания 08.07). ВСЕ точки, где раньше считался дневной план через
// working_calendar (app/api/reports/run, lib/jobs/planSummary, lib/profile/deptSummary,
// lib/jobs/dailyMoscowReport), обязаны брать числа ТОЛЬКО отсюда — иначе цифры разъедутся
// между разделами (см. WORKLOG 2026-07-08).
//
// Режимы (plan_settings.daily_plan_mode, миграция 050):
//  - 'divide20' (дефолт): дневной план = месячный план ÷ 20 — константа, НЕ зависит от
//    фактического числа будней месяца. "Прошедшие будни" (множитель для MTD/pace-таргета)
//    считаются пн–пт по календарным датам, БЕЗ обращения к working_calendar и БЕЗ учёта
//    праздников РФ — иначе режим остался бы зависим от календаря, который мы как раз
//    убираем. (Полноценная формула темпа с этой же логикой "будней" — задача №5, здесь
//    трогаем только источник дневного плана в существующих расчётах.)
//  - 'calendar': прежняя логика без изменений — оба числа (сколько рабочих дней всего /
//    сколько уже прошло) читаются из working_calendar (учитывает праздники, isdayoff.ru).
//    Используется, только если супер-админ явно переключил тумблер в /settings/daily-plan-mode.
//
// Настройку можно переключать только супер-админу (см. lib/auth/perms.ts superadminError,
// app/api/settings/daily-plan-mode/route.ts).

import { systemDb } from '@/lib/db/clients';

export type DailyPlanMode = 'divide20' | 'calendar';

export const DEFAULT_DAILY_PLAN_MODE: DailyPlanMode = 'divide20';
const FIXED_MONTH_DIVISOR = 20;
const FIXED_WEEK_DIVISOR = 5; // пн-пт константа для divide20-режима

let modeCache: { value: DailyPlanMode; at: number } | null = null;
const MODE_CACHE_TTL_MS = 60_000; // тумблер супер-админа должен подхватываться быстро, но не дёргать БД на каждый запрос

/** Текущий глобальный режим. Фолбэк на дефолт ('divide20'), если строка плана ещё не
 *  создана или колонка ещё не накатана миграцией (безопасно на случай рассинхрона
 *  порядка деплоя кода/миграции — дефолт как раз совпадает с решением собрания). */
export async function getDailyPlanMode(): Promise<DailyPlanMode> {
  if (modeCache && Date.now() - modeCache.at < MODE_CACHE_TTL_MS) return modeCache.value;
  let value: DailyPlanMode = DEFAULT_DAILY_PLAN_MODE;
  try {
    const res = await systemDb().query<{ daily_plan_mode: string | null }>(
      `SELECT daily_plan_mode FROM plan_settings WHERE id = 1`
    );
    if (res.rows[0]?.daily_plan_mode === 'calendar') value = 'calendar';
  } catch {
    /* колонка/таблица недоступна — остаёмся на дефолте */
  }
  modeCache = { value, at: Date.now() };
  return value;
}

/** Сбросить кэш режима сразу после сохранения тумблера в settings-роуте. */
export function invalidateDailyPlanModeCache(): void {
  modeCache = null;
}

export interface WorkingDayProgress {
  /** Сколько рабочих дней всего в периоде ("дневной план" = план / total). */
  total: number;
  /** Сколько рабочих дней уже прошло на дату asOf (включительно). */
  passed: number;
}

/** Считает будни (пн–пт) между from и to включительно, по календарным датам,
 *  БЕЗ учёта праздников. Используется только в divide20-режиме. */
function countWeekdaysInclusive(fromStr: string, toStr: string): number {
  if (toStr < fromStr) return 0;
  const from = new Date(`${fromStr}T00:00:00Z`);
  const to = new Date(`${toStr}T00:00:00Z`);
  let count = 0;
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay(); // 0=Вс..6=Сб
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

function clampToMonth(dateStr: string, monthFirstDay: string): string {
  const monthEndExclusive = new Date(`${monthFirstDay}T00:00:00Z`);
  monthEndExclusive.setUTCMonth(monthEndExclusive.getUTCMonth() + 1);
  const monthLastDay = new Date(monthEndExclusive.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (dateStr < monthFirstDay) return monthFirstDay;
  if (dateStr > monthLastDay) return monthLastDay;
  return dateStr;
}

function clampToWeek(dateStr: string, weekStartDay: string): string {
  const weekEndExclusive = new Date(`${weekStartDay}T00:00:00Z`);
  weekEndExclusive.setUTCDate(weekEndExclusive.getUTCDate() + 7);
  const weekLastDay = new Date(weekEndExclusive.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (dateStr < weekStartDay) return weekStartDay;
  if (dateStr > weekLastDay) return weekLastDay;
  return dateStr;
}

/**
 * Прогресс рабочих дней МЕСЯЦА — для дневного плана (movthly plan / total * passed).
 * monthFirstDay: 'YYYY-MM-01'. asOfDateStr: 'YYYY-MM-DD' (обычно сегодня, МСК).
 */
export async function getMonthWorkingDays(monthFirstDay: string, asOfDateStr: string): Promise<WorkingDayProgress> {
  const mode = await getDailyPlanMode();

  if (mode === 'divide20') {
    const capped = clampToMonth(asOfDateStr, monthFirstDay);
    return { total: FIXED_MONTH_DIVISOR, passed: countWeekdaysInclusive(monthFirstDay, capped) };
  }

  // calendar — прежняя логика (working_calendar), без изменений.
  const res = await systemDb().query<{ total_working: string; days_passed: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE is_working AND to_char(date, 'YYYY-MM') = to_char($1::date, 'YYYY-MM')) AS total_working,
       COUNT(*) FILTER (WHERE is_working AND to_char(date, 'YYYY-MM') = to_char($1::date, 'YYYY-MM') AND date <= $2::date) AS days_passed
     FROM working_calendar
     WHERE to_char(date, 'YYYY-MM') = to_char($1::date, 'YYYY-MM')`,
    [monthFirstDay, asOfDateStr]
  );
  const total = parseInt(res.rows[0]?.total_working ?? '0', 10);
  const passed = parseInt(res.rows[0]?.days_passed ?? '0', 10);
  // Фолбэк на случай, если календарь ещё не заполнен на этот месяц/год (как было раньше).
  return { total: total || 22, passed: passed || 1 };
}

/** Рабочих дней в НЕДЕЛЕ, начинающейся с weekStartStr (Пн), для недельного плана
 *  (ежедневный Bitrix-отчёт). divide20 — константа 5 (пн-пт); calendar — как раньше,
 *  из working_calendar (учитывает праздники). */
export async function getWeekWorkingDaysTotal(weekStartStr: string): Promise<number> {
  const mode = await getDailyPlanMode();
  if (mode === 'divide20') return FIXED_WEEK_DIVISOR;

  const weekEndExclusive = new Date(`${weekStartStr}T00:00:00Z`);
  weekEndExclusive.setUTCDate(weekEndExclusive.getUTCDate() + 7);
  const res = await systemDb().query<{ in_week: string }>(
    `SELECT COUNT(*) FILTER (WHERE is_working AND date >= $1::date AND date < $2::date) AS in_week
     FROM working_calendar`,
    [weekStartStr, weekEndExclusive.toISOString().slice(0, 10)]
  );
  return parseInt(res.rows[0]?.in_week ?? '0', 10) || FIXED_WEEK_DIVISOR;
}

/**
 * Прогресс рабочих дней НЕДЕЛИ (пн-старт) — для метрик «Выполнение плана ... (неделя)»
 * (п.5+11 спеки). Симметрично getMonthWorkingDays: divide20 — total фиксирован (5, пн-пт),
 * passed — реальные будни от weekStartStr (Пн) до asOfDateStr включительно, БЕЗ потолка
 * (не может превысить 5 в пределах одной календарной недели, но считается тем же общим
 * счётчиком будней, что и для месяца — единая логика). calendar — из working_calendar.
 */
export async function getWeekWorkingDays(weekStartStr: string, asOfDateStr: string): Promise<WorkingDayProgress> {
  const mode = await getDailyPlanMode();

  if (mode === 'divide20') {
    const capped = clampToWeek(asOfDateStr, weekStartStr);
    return { total: FIXED_WEEK_DIVISOR, passed: countWeekdaysInclusive(weekStartStr, capped) };
  }

  // calendar — прежняя логика (working_calendar), без изменений.
  const weekEndExclusive = new Date(`${weekStartStr}T00:00:00Z`);
  weekEndExclusive.setUTCDate(weekEndExclusive.getUTCDate() + 7);
  const res = await systemDb().query<{ total_working: string; days_passed: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE is_working) AS total_working,
       COUNT(*) FILTER (WHERE is_working AND date <= $3::date) AS days_passed
     FROM working_calendar
     WHERE date >= $1::date AND date < $2::date`,
    [weekStartStr, weekEndExclusive.toISOString().slice(0, 10), asOfDateStr]
  );
  const total = parseInt(res.rows[0]?.total_working ?? '0', 10);
  const passed = parseInt(res.rows[0]?.days_passed ?? '0', 10);
  return { total: total || FIXED_WEEK_DIVISOR, passed: passed || 0 };
}

/**
 * Прогресс рабочих дней ГОДА — для Сводной (годовой таргет, YTD-темп). divide20:
 * 12 месяцев × 20 = 240 (константа), прошедшие — будни с 1 января по asOf. calendar:
 * как раньше, working_calendar за календарный год; null, если календарь не заполнен
 * на этот год (сохраняет прежнее поведение "не показываем темп").
 */
export async function getYearWorkingDays(year: number, asOfDateStr: string): Promise<WorkingDayProgress | null> {
  const mode = await getDailyPlanMode();

  if (mode === 'divide20') {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const capped = asOfDateStr < yearStart ? yearStart : (asOfDateStr > yearEnd ? yearEnd : asOfDateStr);
    return { total: 12 * FIXED_MONTH_DIVISOR, passed: countWeekdaysInclusive(yearStart, capped) };
  }

  const res = await systemDb().query<{ total_working: string; days_passed: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE is_working) AS total_working,
       COUNT(*) FILTER (WHERE is_working AND date <= $2::date) AS days_passed
     FROM working_calendar
     WHERE date >= $1::date AND date <= ($1::date + INTERVAL '1 year' - INTERVAL '1 day')`,
    [`${year}-01-01`, asOfDateStr]
  );
  const total = parseInt(res.rows[0]?.total_working ?? '0', 10);
  if (!total) return null; // календарь на этот год не заполнен — как и раньше
  return { total, passed: parseInt(res.rows[0]?.days_passed ?? '0', 10) };
}
