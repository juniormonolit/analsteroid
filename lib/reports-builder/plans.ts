// Планы продаж/отгрузок по менеджерам для конструктора отчётов.
//
// Логика ДОСЛОВНО та же, что в ежедневном отчёте «МОСКВА»
// (lib/jobs/dailyMoscowReport.ts) — иначе «% ПЛАНА» в конструкторе и в боте
// разошлись бы, и человек получил бы два разных ответа на один вопрос:
//   * план продаж = plan_shipments / plan_n (manager_plans);
//   * дневной план = месячный ÷ рабочие дни месяца;
//   * неделя и месяц — ТЕМП: план на ПРОШЕДШИЕ рабочие дни, а не на весь период
//     (правка владельца 21.07);
//   * manager_plans живёт в системной БД, оргструктура — в sa: кросс-БД JOIN
//     невозможен, джойним в коде по short_login (семантика INNER JOIN).

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { getMonthWorkingDays, getWeekWorkingDays } from '@/lib/plans/dailyPlan';

export interface ManagerPlan {
  /** Месячный план продаж, ₽. */
  sales: number;
  /** Месячный план отгрузок, ₽. */
  shipments: number;
}

/** Плановые множители окон: дневной план × столько-то рабочих дней. */
export interface PlanWindows {
  day: number;
  week: number;
  month: number;
}

export async function getMonthPlansByManager(monthFirstDay: string): Promise<Map<string, ManagerPlan>> {
  const [plansRes, orhRes] = await Promise.all([
    systemDb().query<{ manager_login: string; plan_shipments: string; plan_n: string }>(
      `SELECT manager_login, plan_shipments, plan_n FROM manager_plans WHERE month = $1::date`,
      [monthFirstDay],
    ),
    analyticsDb().query<{ manager_id: string; short_login: string }>(
      `SELECT manager_bitrix_user_id::text AS manager_id, short_login
         FROM sa.org_resolved_hierarchy WHERE is_active = true AND short_login IS NOT NULL`,
    ),
  ]);
  const managerIdByShortLogin = new Map(orhRes.rows.map(r => [r.short_login, r.manager_id]));

  const out = new Map<string, ManagerPlan>();
  for (const row of plansRes.rows) {
    const managerId = managerIdByShortLogin.get(row.manager_login);
    if (!managerId) continue; // нет активного менеджера с таким short_login
    const shipments = parseFloat(row.plan_shipments) || 0;
    const n = parseFloat(row.plan_n);
    const sales = n > 0 ? shipments / n : shipments;
    const prev = out.get(managerId);
    out.set(managerId, {
      sales: (prev?.sales ?? 0) + sales,
      shipments: (prev?.shipments ?? 0) + shipments,
    });
  }
  return out;
}

/**
 * Доли месячного плана, приходящиеся на окна день/неделя/месяц отчётной даты.
 * Умножив месячный план менеджера на эти числа, получаем план окна.
 */
export async function getPlanWindows(
  monthFirstDay: string,
  reportDate: string,
  weekStart: string,
): Promise<PlanWindows> {
  const [month, week] = await Promise.all([
    getMonthWorkingDays(monthFirstDay, reportDate),
    getWeekWorkingDays(weekStart, reportDate),
  ]);
  const perDay = month.total > 0 ? 1 / month.total : 0;
  return {
    day: perDay,
    week: perDay * week.passed,
    month: perDay * month.passed,
  };
}
