// «Большой брат» — показатели отдела РОПа из движка отчётов (те же цифры, что «Отчёты → По менеджерам»).
// Выбраны существующие метрики каталога (BIG_BROTHER_SPEC.md — «против показателей отдела»):
//  - Продажи, ₽ = primary_sales_amount + repeat_sales_amount (как виджет «Сводной», lib/jobs/widgetMetrics.ts);
//  - Выполнение плана = продажи / план продаж на период (computePeriodPlanByLogin — та же формула, что «План (на период)»);
//  - CR Сделка → Продажа (cr_deal_to_sale_all) = Σ sales_count / Σ deals_count (формула каталога, миграция 041);
//  - CR Сделка → Бронь (cr_deal_to_reservation_all) = Σ reservations_count / Σ deals_count (миграция 041; «Месяц по РОПам»);
//  - Средний чек (all_sales_avg_amount) = продажи ₽ / Σ sales_count (только calculated — сумма/кол-во, не среднее средних).
// Отдел РОПа = его подчинённые по оргструктуре + он сам (свои продажи РОПа входят в результат отдела).
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { computePeriodPlanByLogin } from '@/lib/plans/dailyPlan';
import type { BbPeriod } from './period';
import { mskDay } from './period';
import type { DeptMetrics } from './types';

export interface MemberMetrics { salesAmount: number; planAmount: number | null; salesCount: number; dealsCount: number; reservationsCount: number }

const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const cache = new Map<string, { at: number; p: Promise<Map<string, MemberMetrics>> }>();
const TTL_MS = 10 * 60_000;

/** Метрики каждого менеджера за период (ключ — Bitrix id). shortLoginById — для плана (manager_plans по short_login). */
export function memberMetrics(period: BbPeriod, shortLoginById: Map<string, string>): Promise<Map<string, MemberMetrics>> {
  const key = `${period.from}:${period.to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = (async () => {
    const today = mskDay(Date.now());
    const [rows, plan] = await Promise.all([
      fetchByManagers({
        period: { from: new Date(`${period.from}T00:00:00.000Z`), to: new Date(`${period.to}T23:59:59.999Z`) },
        dealScope: 'all', clientType: 'all', accountType: 'all',
      }),
      computePeriodPlanByLogin(period.from, period.to, today).catch(() => ({ byLogin: new Map() })),
    ]);
    const out = new Map<string, MemberMetrics>();
    for (const r of rows) {
      const m = r.metrics;
      out.set(r.dimensionId, {
        salesAmount: num(m.primary_sales_amount) + num(m.repeat_sales_amount),
        planAmount: null, salesCount: num(m.sales_count), dealsCount: num(m.deals_count),
        reservationsCount: num(m.reservations_count),
      });
    }
    for (const [id, login] of shortLoginById) {
      const p = plan.byLogin.get(login);
      if (!p) continue;
      const cur = out.get(id) ?? { salesAmount: 0, planAmount: null, salesCount: 0, dealsCount: 0, reservationsCount: 0 };
      cur.planAmount = (cur.planAmount ?? 0) + num(p.planSales);
      out.set(id, cur);
    }
    return out;
  })();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}

export function aggregate(ids: Iterable<string>, by: Map<string, MemberMetrics>): DeptMetrics | null {
  let salesAmount = 0, plan = 0, planPresent = false, salesCount = 0, dealsCount = 0, reservationsCount = 0, any = false;
  for (const id of ids) {
    const m = by.get(id);
    if (!m) continue;
    any = true;
    salesAmount += m.salesAmount; salesCount += m.salesCount; dealsCount += m.dealsCount; reservationsCount += m.reservationsCount;
    if (m.planAmount != null) { plan += m.planAmount; planPresent = true; }
  }
  if (!any) return null;
  return {
    salesAmount, salesCount, dealsCount, reservationsCount,
    planAmount: planPresent ? plan : null,
    planPct: planPresent && plan > 0 ? salesAmount / plan : null,
    cr: dealsCount > 0 ? salesCount / dealsCount : null,
    crReserve: dealsCount > 0 ? reservationsCount / dealsCount : null,
    avgCheck: salesCount > 0 ? salesAmount / salesCount : null,
  };
}
