// План/факт-полоса ЛК менеджера («Карточка 10.0», задача владельца 29.07):
// Сегодня · Неделя · Месяц — продажи/брони/подтв./отгрузки факт и план + звонки.
// Планы — та же логика темпа, что везде (lib/plans/dailyPlan): дневной план =
// месячный ÷ рабочие дни, план окна = дневной × рабочие дни окна (прошедшие).
// Окна — стенные даты МСК; день = сегодня, неделя = с понедельника, месяц = с 1-го.

import { analyticsDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { computePeriodPlanByLogin } from '@/lib/plans/dailyPlan';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

const TZ = 'Europe/Moscow';

const FACT_IDS = [
  'primary_sales_count', 'repeat_sales_count', 'primary_sales_amount', 'repeat_sales_amount',
  'reservations_count', 'reservations_amount', 'confirmed_reservations_count',
  'primary_shipments_count', 'repeat_shipments_count', 'primary_shipments_amount', 'repeat_shipments_amount',
  'primary_deals_count',
] as const;
type FactId = (typeof FACT_IDS)[number];

export interface PlanFactBucket {
  fromStr: string; // YYYY-MM-DD (МСК, включительно)
  toStr: string;
  salesCount: number;
  salesAmount: number;
  planSales: number | null;
  reservationsCount: number;
  reservationsAmount: number;
  confirmedCount: number; // сумма подтв. броней: метрики-суммы в каталоге нет — только кол-во
  shipmentsCount: number;
  shipmentsAmount: number;
  planShipments: number | null;
  callsOut: number;
  callMinutes: number;
}

export interface PlanFactResult {
  day: PlanFactBucket;
  week: PlanFactBucket;
  month: PlanFactBucket;
  monthExtras: {
    primarySalesAmount: number;
    repeatSalesAmount: number;
    repeatSharePct: number | null;      // % повт. продаж к общим (по сумме)
    convDealToSalePct: number | null;   // конверсия сделка → продажа (перв., как в ежедневном отчёте)
  };
}

function mskTodayStr(): string {
  const now = toZonedTime(new Date(), TZ);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function mskMidnightIso(dateStr: string): string {
  return fromZonedTime(`${dateStr} 00:00:00`, TZ).toISOString();
}

async function fetchFacts(managerIdsNum: number[], fromIso: string, toExclIso: string): Promise<Record<FactId, number>> {
  const all = await loadMetrics();
  const metrics = all.filter(m => (FACT_IDS as readonly string[]).includes(m.id));
  const zero = Object.fromEntries(FACT_IDS.map(id => [id, 0])) as Record<FactId, number>;
  const sql = buildCollectedSQL(metrics, {
    idExpr: `'all'`,
    groupBy: 'GROUP BY 1',
    notNullWhere: `d.current_manager_id IN (${managerIdsNum.join(',')})`,
  });
  if (!sql) return zero;
  const res = await analyticsDb().query<Record<string, unknown>>(sql, [fromIso, toExclIso]);
  const row = res.rows[0];
  if (!row) return zero;
  for (const id of FACT_IDS) {
    const v = row[id];
    zero[id] = v !== null && v !== undefined ? Number(v) : 0;
  }
  return zero;
}

async function fetchCalls(managerIdsNum: number[], fromIso: string, toExclIso: string): Promise<{ out: number; minutes: number }> {
  try {
    const res = await analyticsDb().query<{ out_count: string; talk_seconds: string | null }>(
      `SELECT count(*) FILTER (WHERE direction = 'outbound') AS out_count,
              sum(duration_seconds) FILTER (WHERE result = 'completed') AS talk_seconds
         FROM va.calls
        WHERE manager_id = ANY($1::int[]) AND called_at >= $2 AND called_at < $3`,
      [managerIdsNum, fromIso, toExclIso],
    );
    const row = res.rows[0];
    return { out: Number(row?.out_count ?? 0), minutes: Math.round(Number(row?.talk_seconds ?? 0) / 60) };
  } catch (e) {
    console.warn('[plan-fact] va.calls недоступна:', e instanceof Error ? e.message : e);
    return { out: 0, minutes: 0 };
  }
}

/** Суммарный план окна (темп) по набору менеджеров. null — планов нет ни у кого. */
async function fetchPlans(logins: string[], fromStr: string, toStr: string, todayStr: string): Promise<{ sales: number | null; shipments: number | null }> {
  if (logins.length === 0) return { sales: null, shipments: null };
  const { byLogin } = await computePeriodPlanByLogin(fromStr, toStr, todayStr);
  let sales = 0, shipments = 0, any = false;
  for (const login of logins) {
    const entry = byLogin.get(login);
    if (!entry) continue;
    any = true;
    sales += entry.planSales;
    shipments += entry.planShipments;
  }
  return any ? { sales, shipments } : { sales: null, shipments: null };
}

function toBucket(fromStr: string, toStr: string, f: Record<FactId, number>, plans: { sales: number | null; shipments: number | null }, calls: { out: number; minutes: number }): PlanFactBucket {
  return {
    fromStr, toStr,
    salesCount: f.primary_sales_count + f.repeat_sales_count,
    salesAmount: f.primary_sales_amount + f.repeat_sales_amount,
    planSales: plans.sales,
    reservationsCount: f.reservations_count,
    reservationsAmount: f.reservations_amount,
    confirmedCount: f.confirmed_reservations_count,
    shipmentsCount: f.primary_shipments_count + f.repeat_shipments_count,
    shipmentsAmount: f.primary_shipments_amount + f.repeat_shipments_amount,
    planShipments: plans.shipments,
    callsOut: calls.out,
    callMinutes: calls.minutes,
  };
}

export async function buildPlanFact(managerIds: string[]): Promise<PlanFactResult> {
  const idsNum = managerIds.map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (idsNum.length === 0) throw new Error('Нет менеджеров для план/факта');

  const loginsRes = await analyticsDb().query<{ short_login: string }>(
    `SELECT short_login FROM sa.org_resolved_hierarchy
      WHERE manager_bitrix_user_id::text = ANY($1::text[]) AND short_login IS NOT NULL`,
    [idsNum.map(String)],
  );
  const logins = loginsRes.rows.map(r => r.short_login);

  const today = mskTodayStr();
  const weekStart = mondayOf(today);
  const monthStart = `${today.slice(0, 7)}-01`;
  const nextDayIso = mskMidnightIso(addDaysStr(today, 1));

  const windows = [
    { key: 'day' as const, fromStr: today },
    { key: 'week' as const, fromStr: weekStart },
    { key: 'month' as const, fromStr: monthStart },
  ];

  const [factsArr, callsArr, plansArr] = await Promise.all([
    Promise.all(windows.map(w => fetchFacts(idsNum, mskMidnightIso(w.fromStr), nextDayIso))),
    Promise.all(windows.map(w => fetchCalls(idsNum, mskMidnightIso(w.fromStr), nextDayIso))),
    Promise.all(windows.map(w => fetchPlans(logins, w.fromStr, today, today))),
  ]);

  const monthF = factsArr[2];
  const buckets = windows.map((w, i) => toBucket(w.fromStr, today, factsArr[i], plansArr[i], callsArr[i]));

  const totalSalesAmount = monthF.primary_sales_amount + monthF.repeat_sales_amount;
  return {
    day: buckets[0],
    week: buckets[1],
    month: buckets[2],
    monthExtras: {
      primarySalesAmount: monthF.primary_sales_amount,
      repeatSalesAmount: monthF.repeat_sales_amount,
      repeatSharePct: totalSalesAmount > 0 ? (monthF.repeat_sales_amount / totalSalesAmount) * 100 : null,
      convDealToSalePct: monthF.primary_deals_count > 0 ? (monthF.primary_sales_count / monthF.primary_deals_count) * 100 : null,
    },
  };
}
