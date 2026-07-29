// Единый источник "рабочих дней" для расчёта дневного плана — п.7 согласованной
// спеки (решение собрания 08.07). ВСЕ точки, где раньше считался дневной план через
// working_calendar (app/api/reports/run, lib/jobs/planSummary, lib/profile/deptSummary,
// lib/jobs/dailyMoscowReport), обязаны брать числа ТОЛЬКО отсюда — иначе цифры разъедутся
// между разделами (см. WORKLOG 2026-07-08).
//
// Режимы (plan_settings.daily_plan_mode, миграция 050):
//  - 'divide20' (дефолт): дневной план = месячный план ÷ 20 — константа, НЕ зависит от
//    фактического числа будней месяца. "Прошедшие будни" (множитель для MTD/pace-таргета
//    месяца/недели) считаются пн–пт по календарным датам, БЕЗ обращения к working_calendar
//    и БЕЗ учёта праздников РФ — иначе режим остался бы зависим от календаря, который мы
//    как раз убираем.
//  - 'calendar': прежняя логика без изменений — оба числа (сколько рабочих дней всего /
//    сколько уже прошло) читаются из working_calendar (учитывает праздники, isdayoff.ru).
//    Используется, только если супер-админ явно переключил тумблер в /settings/daily-plan-mode.
//
// Настройку можно переключать только супер-админу (см. lib/auth/perms.ts superadminError,
// app/api/settings/daily-plan-mode/route.ts).
//
// ГОДОВОЙ темп Сводной (lib/jobs/planSummary.ts): решением владельца 08.07 короткое
// время считался как ÷365 календарных дней от годового плана (getYearWorkingDays,
// этап 5б п.2) — ОТМЕНЕНО владельцем 10.07: темп теперь считается ПОМЕСЯЧНО (сумма
// месячных планов завершённых месяцев + текущий месяц с весом ÷20, см. getYtdPlanTargets
// в planSummary.ts), getYearWorkingDays как функция больше не нужна и удалена отсюда.

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

export interface PeriodMonthChunk {
  /** 'YYYY-MM' месяца, к которому относится этот кусок периода. */
  month: string;
  /** Делитель дневного плана — рабочих дней ВСЕГО в этом месяце (как getMonthWorkingDays.total). */
  workingDaysInMonth: number;
  /** Будних дней ВНУТРИ пересечения [rangeFromStr, rangeToStr] и этого месяца (не обязательно с 1-го числа). */
  workingDaysInRange: number;
}

/**
 * Задача 10.07 (фикс «план-метрики должны считать рабочие дни ПО ВЫБРАННОМУ ПЕРИОДУ,
 * а не по "сегодня"», owners-inbox): разбивает диапазон [rangeFromStr, rangeToStr]
 * (включительно, обычно rangeToStr = min(period.to, сегодня МСК)) по календарным месяцам.
 * Для КАЖДОГО месяца отдаёт делитель (рабочих дней всего в месяце — divide20: константа 20;
 * calendar: из working_calendar) и числитель (будних дней ИМЕННО внутри диапазона,
 * пересечённого с этим месяцем — НЕ обязательно от 1-го числа, если rangeFromStr позже).
 * Это позволяет корректно считать план на период, пересекающий границу месяца: дни каждого
 * месяца берут дневной план ИМЕННО своего месяца (см. app/api/reports/run).
 */
export async function getWorkingDaysByMonthInRange(
  rangeFromStr: string,
  rangeToStr: string,
): Promise<PeriodMonthChunk[]> {
  if (rangeToStr < rangeFromStr) return [];
  const mode = await getDailyPlanMode();
  const chunks: PeriodMonthChunk[] = [];

  let curMonthFirst = `${rangeFromStr.slice(0, 7)}-01`;
  const lastMonthFirst = `${rangeToStr.slice(0, 7)}-01`;

  while (curMonthFirst <= lastMonthFirst) {
    const monthEndExclusive = new Date(`${curMonthFirst}T00:00:00Z`);
    monthEndExclusive.setUTCMonth(monthEndExclusive.getUTCMonth() + 1);
    const monthLastDay = new Date(monthEndExclusive.getTime() - 86_400_000).toISOString().slice(0, 10);

    const chunkFrom = rangeFromStr > curMonthFirst ? rangeFromStr : curMonthFirst;
    const chunkTo = rangeToStr < monthLastDay ? rangeToStr : monthLastDay;

    if (chunkFrom <= chunkTo) {
      if (mode === 'divide20') {
        chunks.push({
          month: curMonthFirst.slice(0, 7),
          workingDaysInMonth: FIXED_MONTH_DIVISOR,
          workingDaysInRange: countWeekdaysInclusive(chunkFrom, chunkTo),
        });
      } else {
        // calendar — прежняя логика (working_calendar), без изменений режима.
        const res = await systemDb().query<{ total_working: string; in_range: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE is_working) AS total_working,
             COUNT(*) FILTER (WHERE is_working AND date >= $2::date AND date <= $3::date) AS in_range
           FROM working_calendar
           WHERE to_char(date, 'YYYY-MM') = $1`,
          [curMonthFirst.slice(0, 7), chunkFrom, chunkTo],
        );
        const total = parseInt(res.rows[0]?.total_working ?? '0', 10) || 22; // фолбэк как в getMonthWorkingDays
        const inRange = parseInt(res.rows[0]?.in_range ?? '0', 10);
        chunks.push({ month: curMonthFirst.slice(0, 7), workingDaysInMonth: total, workingDaysInRange: inRange });
      }
    }

    const next = new Date(`${curMonthFirst}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    curMonthFirst = next.toISOString().slice(0, 10);
  }

  return chunks;
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

export interface PeriodPlanEntry { planSales: number; planShipments: number }

/**
 * План продаж/отгрузок каждого менеджера (по short_login) за выбранный период — те же
 * рабочие дни периода∩сегодня × дневной план ЕГО месяца, что и «План (на период)» в
 * app/api/reports/run (задача 10.07). Вынесено сюда (задача виджет-конструктора), чтобы
 * не дублировать денежную логику между отчётом и джобой предрасчёта виджетов
 * (lib/jobs/widgetMetrics.ts). Возвращает только менеджеров, у кого есть план хотя бы на
 * один месяц периода. planSales = plan_shipments/plan_n дневной, planShipments = plan_shipments
 * дневной (та же формула, что в reports/run enrichRow).
 */
export async function computePeriodPlanByLogin(
  periodFromStr: string,
  periodToStrRaw: string,
  mskTodayStr: string,
): Promise<{ byLogin: Map<string, PeriodPlanEntry>; rangeToStr: string }> {
  const rangeToStr = periodToStrRaw < mskTodayStr ? periodToStrRaw : mskTodayStr;
  if (rangeToStr < periodFromStr) return { byLogin: new Map(), rangeToStr };

  const chunks = await getWorkingDaysByMonthInRange(periodFromStr, rangeToStr);
  if (chunks.length === 0) return { byLogin: new Map(), rangeToStr };

  const months = chunks.map(c => c.month);
  const plansRes = await systemDb().query<{ manager_login: string; month: string; plan_shipments: string; plan_n: string }>(
    `SELECT manager_login, to_char(month, 'YYYY-MM') as month, plan_shipments, plan_n
     FROM manager_plans WHERE to_char(month, 'YYYY-MM') = ANY($1)`,
    [months],
  );

  const planByLoginMonth = new Map<string, Map<string, { plan_shipments: number; plan_n: number }>>();
  for (const row of plansRes.rows) {
    if (!planByLoginMonth.has(row.manager_login)) planByLoginMonth.set(row.manager_login, new Map());
    planByLoginMonth.get(row.manager_login)!.set(row.month, {
      plan_shipments: parseFloat(row.plan_shipments),
      plan_n: parseFloat(row.plan_n),
    });
  }

  const byLogin = new Map<string, PeriodPlanEntry>();
  for (const [login, monthMap] of planByLoginMonth) {
    let planSales = 0;
    let planShipments = 0;
    let any = false;
    for (const chunk of chunks) {
      const mp = monthMap.get(chunk.month);
      if (!mp) continue;
      any = true;
      const dailySales = (mp.plan_shipments / mp.plan_n) / chunk.workingDaysInMonth;
      const dailyShipments = mp.plan_shipments / chunk.workingDaysInMonth;
      planSales += dailySales * chunk.workingDaysInRange;
      planShipments += dailyShipments * chunk.workingDaysInRange;
    }
    if (any) byLogin.set(login, { planSales, planShipments });
  }

  return { byLogin, rangeToStr };
}
