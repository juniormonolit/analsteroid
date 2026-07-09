import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadMetrics, resolveMetricIds, withDependencies } from '@/lib/metrics/catalog';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { fetchByProductGroups } from '@/features/reports/engine/byProductGroups';
import { fetchBySources } from '@/features/reports/engine/bySources';
import { computeCalculated, computeTotals, computeDelta } from '@/features/reports/engine/calculated';
import { applyGrouping } from '@/features/reports/engine/grouping';
import { systemDb } from '@/lib/db/clients';
import { getMonthWorkingDays, getWeekWorkingDays } from '@/lib/plans/dailyPlan';
import { toZonedTime } from 'date-fns-tz';
import type { DealScope, ClientType, Grouping, ReportRow, ProductGroupMode, AccountType } from '@/lib/metrics/types';

// Метрики «Выполнение плана ... (день)/(неделя)» (п.5+11 спеки) — period-relative,
// as-of = конец периода отчёта (или сегодня, если период его включает). Понедельник недели,
// в которую попадает asOf.
function mondayOfWeek(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay(); // 0=Вс..6=Сб
  const diffFromMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diffFromMonday);
  return d.toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const {
    reportSlug = 'by-managers',
    period,
    comparisonPeriod,
    metricIds = ['all_core'],
    dealScope = 'primary' as DealScope,
    clientType = 'all' as ClientType,
    grouping = 'none' as Grouping,
    departmentIds,
    productGroupMode = 'kc' as ProductGroupMode,
    accountType = 'managers' as AccountType,
    managerId,       // drilldown: restrict by-product-groups to one manager
    productGroupId,  // drilldown: restrict by-managers to one product group
    sourceDimension, // by-sources: main dimension (brand/platform/contact_type/ad_channel/branch/source)
    sourceFilter,    // drilldown: { dimension, value } — restrict deals to one dimension value
  } = body;

  const start = Date.now();

  const allMetrics = await loadMetrics();
  const requested = resolveMetricIds(metricIds, allMetrics);
  const withDeps = withDependencies(requested, allMetrics);
  const calculatedMetrics = withDeps.filter(m => m.metricType === 'calculated');

  const opts = {
    period: { from: new Date(period.from), to: new Date(period.to) },
    dealScope,
    clientType,
    departmentIds,
    accountType,
  };
  const compOpts = {
    period: { from: new Date(comparisonPeriod.from), to: new Date(comparisonPeriod.to) },
    dealScope,
    clientType,
    departmentIds,
    accountType,
  };

  let currentRows: ReportRow[] = [];
  let compRows: ReportRow[] = [];

  if (reportSlug === 'by-managers') {
    [currentRows, compRows] = await Promise.all([
      fetchByManagers({ ...opts, productGroupMode, productGroupId, sourceFilter }),
      fetchByManagers({ ...compOpts, productGroupMode, productGroupId, sourceFilter }),
    ]);
  } else if (reportSlug === 'by-product-groups') {
    [currentRows, compRows] = await Promise.all([
      fetchByProductGroups({ period: opts.period, dealScope, clientType, productGroupMode, managerId, departmentIds }),
      fetchByProductGroups({ period: compOpts.period, dealScope, clientType, productGroupMode, managerId, departmentIds }),
    ]);
  } else if (reportSlug === 'by-sources') {
    [currentRows, compRows] = await Promise.all([
      fetchBySources({ period: opts.period, dealScope, clientType, sourceDimension, sourceFilter }),
      fetchBySources({ period: compOpts.period, dealScope, clientType, sourceDimension, sourceFilter }),
    ]);
  }

  // Fetch plan data for external metrics
  const planMetricIds = ['plan_sales_month', 'plan_shipments_month', 'plan_sales_today', 'plan_shipments_today'];
  const hasAnyPlanMetric = withDeps.some(m => planMetricIds.includes(m.id));

  if (hasAnyPlanMetric) {
    const periodStart = new Date(period.from);
    const periodEnd = new Date(period.to);

    const months: string[] = [];
    const cur = new Date(periodStart.getFullYear(), periodStart.getMonth(), 1);
    const end = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);
    while (cur <= end) {
      months.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
      cur.setMonth(cur.getMonth() + 1);
    }

    const sysDb = systemDb();

    const plansRes = await sysDb.query<{ manager_login: string; month: string; plan_shipments: string; plan_n: string }>(
      `SELECT manager_login, to_char(month, 'YYYY-MM') as month, plan_shipments, plan_n
       FROM manager_plans WHERE to_char(month, 'YYYY-MM') = ANY($1)`,
      [months]
    );

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const currentMonthStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    // Источник дневного плана — общий хелпер (п.7 спеки): дефолт "месячный ÷ 20",
    // режим "производственный календарь" — только если супер-админ включил его явно.
    const { total: workingDaysInMonth, passed: workingDayOrdinal } = await getMonthWorkingDays(
      `${currentMonthStr}-01`, todayStr
    );

    const planByLogin = new Map<string, { plan_shipments: number; plan_n: number }>();
    for (const row of plansRes.rows) {
      const existing = planByLogin.get(row.manager_login);
      const ps = parseFloat(row.plan_shipments);
      const pn = parseFloat(row.plan_n);
      if (existing) {
        existing.plan_shipments += ps;
      } else {
        planByLogin.set(row.manager_login, { plan_shipments: ps, plan_n: pn });
      }
    }

    const enrichRow = (row: ReportRow): ReportRow => {
      const login = row.dimensionSubtitle;
      const plan = login ? planByLogin.get(login) : undefined;
      if (!plan) return row;
      const planSalesMonth = plan.plan_shipments / plan.plan_n;
      const planShipmentsMonth = plan.plan_shipments;
      const planSalesToday = (planSalesMonth / workingDaysInMonth) * workingDayOrdinal;
      const planShipmentsToday = (planShipmentsMonth / workingDaysInMonth) * workingDayOrdinal;
      return {
        ...row,
        metrics: {
          ...row.metrics,
          plan_sales_month: planSalesMonth,
          plan_shipments_month: planShipmentsMonth,
          plan_sales_today: planSalesToday,
          plan_shipments_today: planShipmentsToday,
        }
      };
    };
    currentRows = currentRows.map(enrichRow);
    compRows = compRows.map(enrichRow);
  }

  // Метрики «Выполнение плана продаж/отгрузок, % (день)/(неделя)» — п.5+11 спеки.
  // Period-relative: as-of = конец периода отчёта, либо сегодня, если период его включает.
  // Работают только в отчёте «по менеджерам» (планы есть только у менеджеров/отделов, п.5).
  const periodRelativePlanMetricIds = [
    'plan_execution_pct_sales_day', 'plan_execution_pct_sales_week',
    'plan_execution_pct_shipments_day', 'plan_execution_pct_shipments_week',
  ];
  const hasPeriodRelativePlanMetric = withDeps.some(m => periodRelativePlanMetricIds.includes(m.id));

  if (hasPeriodRelativePlanMetric && reportSlug === 'by-managers') {
    const MSK_TZ = 'Europe/Moscow';
    const mskTodayStr = toZonedTime(new Date(), MSK_TZ).toISOString().slice(0, 10);
    // period.from/period.to приходят уже как «MSK-псевдо-UTC» строки (см. lib/period) —
    // берём календарную дату без повторного сдвига таймзоны.
    const periodFromStr = new Date(period.from).toISOString().slice(0, 10);
    const periodToStr = new Date(period.to).toISOString().slice(0, 10);
    const asOfStr = (periodFromStr <= mskTodayStr && mskTodayStr <= periodToStr) ? mskTodayStr : periodToStr;
    const asOfMonthFirst = `${asOfStr.slice(0, 7)}-01`;
    const asOfMonthStr = asOfStr.slice(0, 7);
    const asOfWeekStart = mondayOfWeek(asOfStr);

    const sysDb = systemDb();
    const [asOfPlansRes, mtdRows, wtdRows, monthWd, weekWd] = await Promise.all([
      sysDb.query<{ manager_login: string; plan_shipments: string; plan_n: string }>(
        `SELECT manager_login, plan_shipments, plan_n
         FROM manager_plans WHERE to_char(month, 'YYYY-MM') = $1`,
        [asOfMonthStr]
      ),
      fetchByManagers({
        period: { from: new Date(`${asOfMonthFirst}T00:00:00Z`), to: new Date(`${asOfStr}T00:00:00Z`) },
        dealScope, clientType, departmentIds, accountType, productGroupMode, productGroupId, sourceFilter,
      }),
      fetchByManagers({
        period: { from: new Date(`${asOfWeekStart}T00:00:00Z`), to: new Date(`${asOfStr}T00:00:00Z`) },
        dealScope, clientType, departmentIds, accountType, productGroupMode, productGroupId, sourceFilter,
      }),
      getMonthWorkingDays(asOfMonthFirst, asOfStr),
      getWeekWorkingDays(asOfWeekStart, asOfStr),
    ]);

    // На месяц asOf план не суммируется по нескольким месяцам (в отличие от planByLogin
    // выше, который берёт все месяцы ВЫБРАННОГО периода) — день/неделя всегда меряются
    // ровно относительно одного календарного месяца, в который попадает as-of.
    const asOfPlanByLogin = new Map<string, { plan_shipments: number; plan_n: number }>();
    for (const row of asOfPlansRes.rows) {
      asOfPlanByLogin.set(row.manager_login, { plan_shipments: parseFloat(row.plan_shipments), plan_n: parseFloat(row.plan_n) });
    }

    const mtdByLogin = new Map(mtdRows.map(r => [r.dimensionSubtitle, r.metrics]));
    const wtdByLogin = new Map(wtdRows.map(r => [r.dimensionSubtitle, r.metrics]));

    const enrichPeriodRelative = (row: ReportRow): ReportRow => {
      const login = row.dimensionSubtitle;
      const plan = login ? asOfPlanByLogin.get(login) : undefined;
      if (!plan) return row;

      const planSalesMonth = plan.plan_shipments / plan.plan_n;
      const planShipmentsMonth = plan.plan_shipments;
      const dailyPlanSales = planSalesMonth / monthWd.total;
      const dailyPlanShipments = planShipmentsMonth / monthWd.total;

      const mtd = login ? mtdByLogin.get(login) : undefined;
      const wtd = login ? wtdByLogin.get(login) : undefined;
      // Факт = ВСЕ продажи/отгрузки (перв.+повт.), решение Серёги 08.07 16:57 (этап 5б,
      // п.1). Раньше (миграция 051) считали только primary_*_amount — так исторически
      // было на проде. mtd/wtd приходят из fetchByManagers, которая всегда отдаёт ВСЕ
      // collected-метрики независимо от запроса (см. features/reports/engine/byManagers.ts),
      // поэтому repeat_* поля гарантированно присутствуют в объекте.
      const salesFactMtd = (mtd?.primary_sales_amount ?? 0) + (mtd?.repeat_sales_amount ?? 0);
      const salesFactWtd = (wtd?.primary_sales_amount ?? 0) + (wtd?.repeat_sales_amount ?? 0);
      const shipmentsFactMtd = (mtd?.primary_shipments_amount ?? 0) + (mtd?.repeat_shipments_amount ?? 0);
      const shipmentsFactWtd = (wtd?.primary_shipments_amount ?? 0) + (wtd?.repeat_shipments_amount ?? 0);

      return {
        ...row,
        metrics: {
          ...row.metrics,
          sales_fact_mtd: salesFactMtd,
          sales_fact_wtd: salesFactWtd,
          shipments_fact_mtd: shipmentsFactMtd,
          shipments_fact_wtd: shipmentsFactWtd,
          plan_sales_target_mtd: dailyPlanSales * monthWd.passed,
          plan_sales_target_wtd: dailyPlanSales * weekWd.passed,
          plan_shipments_target_mtd: dailyPlanShipments * monthWd.passed,
          plan_shipments_target_wtd: dailyPlanShipments * weekWd.passed,
        },
      };
    };
    currentRows = currentRows.map(enrichPeriodRelative);
    compRows = compRows.map(enrichPeriodRelative);
  }

  // Add calculated metrics to each row (after plan enrichment so plan-dependent metrics work)
  const enrich = (row: ReportRow): ReportRow => ({
    ...row,
    metrics: computeCalculated(row.metrics, calculatedMetrics),
  });
  currentRows = currentRows.map(enrich);
  compRows = compRows.map(enrich);

  // Merge current + comparison by dimensionId
  const compMap = new Map(compRows.map(r => [r.dimensionId, r]));
  const mergedRows = currentRows.map(row => {
    const comp = compMap.get(row.dimensionId);
    const metricIds = Object.keys(row.metrics);
    const deltas: Record<string, { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null }> = {};
    for (const id of metricIds) {
      deltas[id] = {
        current: row.metrics[id] ?? null,
        comparison: comp?.metrics[id] ?? null,
        ...computeDelta(row.metrics[id] ?? null, comp?.metrics[id] ?? null),
      };
    }
    return { ...row, deltas };
  });

  // Apply grouping
  const grouped = applyGrouping(currentRows, grouping, allMetrics);

  // Totals: агрегат текущего периода — «как раньше» (сумма collected/external, calculated
  // пересчитан из сумм — см. computeTotals). Баг 09.07 (собрание, п.3/п.6): строка «Итого»
  // в развёрнутом сравнении теряла «Пред.»/Δ/Δ% — потому что comparison-период вообще не
  // агрегировался, значения неоткуда было взять. Чиним симметрично: считаем totals ТЕМ ЖЕ
  // способом (computeTotals) по compRows, затем — тот же computeDelta, что и по строкам.
  // Не-суммируемые метрики (проценты/CR) корректны в обеих колонках одинаково: они не
  // усредняются построчно, а пересчитываются по формуле из суммированных компонентов
  // (см. computeTotals → computeCalculated) — ровно так же для «Тек.» и для «Пред.».
  const totalsCurrentRaw = computeTotals(currentRows, allMetrics);
  const totalsCurrent = computeCalculated(totalsCurrentRaw, calculatedMetrics);
  const totalsComparisonRaw = computeTotals(compRows, allMetrics);
  const totalsComparison = computeCalculated(totalsComparisonRaw, calculatedMetrics);
  const totalIds = new Set([...Object.keys(totalsCurrent), ...Object.keys(totalsComparison)]);
  const totals: Record<string, { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null }> = {};
  for (const id of totalIds) {
    const current = totalsCurrent[id] ?? null;
    const comparison = totalsComparison[id] ?? null;
    totals[id] = { current, comparison, ...computeDelta(current, comparison) };
  }

  return NextResponse.json({
    rows: mergedRows,
    grouped,
    totals,
    metrics: requested.filter(m => !m.isHiddenInUi),
    meta: {
      period: { from: period.from, to: period.to },
      comparisonPeriod: { from: comparisonPeriod.from, to: comparisonPeriod.to },
      cacheHit: false,
      durationMs: Date.now() - start,
    },
  });
}
