import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadMetrics, resolveMetricIds, withDependencies } from '@/lib/metrics/catalog';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { fetchByProductGroups } from '@/features/reports/engine/byProductGroups';
import { fetchBySources } from '@/features/reports/engine/bySources';
import { fetchManagerActivity, getCalendarWorkingDaysInPeriod } from '@/features/reports/engine/managerActivity';
import { fetchStageConversions, STAGE_PAIRS, type StageConversionRow } from '@/features/reports/engine/stageConversions';
import { fetchPriceObjectionConversion } from '@/features/reports/engine/priceObjectionConversion';
import {
  fetchCallsBaseMetrics, fetchDealCallAdditive, fetchTouchAndFirstCallMedians, fetchCallSilence,
  type Bucket, type CallsBaseRow, type DealCallAdditiveRow, type TouchAndFirstCallRow,
} from '@/features/reports/engine/callsMetrics';
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

  // Метрики активности менеджеров «Дней в работе» / «% выхода» / «Сделок/день» —
  // спека 09.07+допы (задача 10.07, см. features/reports/engine/managerActivity.ts).
  // Смысл только в разрезе менеджеров — инжектим ТОЛЬКО в by-managers; для
  // by-product-groups/by-sources ключи просто не появляются в row.metrics, и
  // computeCalculated по цепочке зависимостей отдаёт null (это и есть «верни null»).
  const activityMetricIds = [
    'manager_worked_days_count', 'manager_attendance_pct', 'manager_deals_per_worked_day',
  ];
  const hasActivityMetric = withDeps.some(m => activityMetricIds.includes(m.id));

  if (hasActivityMetric && reportSlug === 'by-managers') {
    const [curActivity, curCalDays, compActivity, compCalDays] = await Promise.all([
      fetchManagerActivity(opts.period),
      getCalendarWorkingDaysInPeriod(opts.period),
      fetchManagerActivity(compOpts.period),
      getCalendarWorkingDaysInPeriod(compOpts.period),
    ]);

    const enrichActivity = (
      row: ReportRow,
      activity: Awaited<ReturnType<typeof fetchManagerActivity>>,
      calendarDays: number | null,
    ): ReportRow => {
      const a = activity?.get(row.dimensionId);
      return {
        ...row,
        metrics: {
          ...row.metrics,
          // null только если ВЕСЬ период раньше старта сбора deal_events (03.04.2026,
          // см. DEAL_EVENTS_DATA_START) — иначе 0 для менеджеров без рабочих дней.
          manager_worked_days_count: activity ? (a?.workedDays ?? 0) : null,
          manager_primary_deals_activity: activity ? (a?.primaryDealsForActivity ?? 0) : null,
          manager_period_calendar_days: calendarDays,
        },
      };
    };
    currentRows = currentRows.map(r => enrichActivity(r, curActivity, curCalDays));
    compRows = compRows.map(r => enrichActivity(r, compActivity, compCalDays));
  }

  // Матрица CR по основному пути ЧЛ+ЮЛ (задача 2, migrations/064) — «Новая → Взял в
  // работу → ... → Отгрузка» + «X → Отказ». Смысл только в разрезе менеджеров
  // (deal_events.manager_id атрибутирует переход) — инжектим ТОЛЬКО в by-managers,
  // как и manager-activity выше; для by-product-groups/by-sources ключи просто
  // отсутствуют → computeCalculated по цепочке зависимостей отдаёт null.
  const stageConversionHiddenIds = [
    ...new Set(STAGE_PAIRS.flatMap(p => [`stage_${p.from}_denom`, `stage_${p.id}_num`])),
  ];
  const hasStageConversionMetric = withDeps.some(m => stageConversionHiddenIds.includes(m.id));

  if (hasStageConversionMetric && reportSlug === 'by-managers') {
    const [curConv, compConv] = await Promise.all([
      fetchStageConversions(opts.period),
      fetchStageConversions(compOpts.period),
    ]);

    const enrichStageConv = (
      row: ReportRow,
      conv: Map<string, StageConversionRow> | null,
    ): ReportRow => {
      const c = conv?.get(row.dimensionId);
      const metrics: Record<string, number | null> = {};
      for (const pair of STAGE_PAIRS) {
        const denomId = `stage_${pair.from}_denom`;
        const numId = `stage_${pair.id}_num`;
        // null только если ВЕСЬ период раньше DEAL_EVENTS_DATA_START — иначе 0 для
        // менеджеров без сделок в этой стадии за период (честный ноль, не «нет данных»).
        metrics[denomId] = conv ? (c?.denom[pair.from] ?? 0) : null;
        metrics[numId] = conv ? (c?.num[pair.id] ?? 0) : null;
      }
      return { ...row, metrics: { ...row.metrics, ...metrics } };
    };
    currentRows = currentRows.map(r => enrichStageConv(r, curConv));
    compRows = compRows.map(r => enrichStageConv(r, compConv));
  }

  // CR «Есть цена дешевле» → Бронь/Продажа/Отказ (задача 1, migrations/064) —
  // тот же гейт (только by-managers), тот же приём «null только если весь период
  // раньше старта сбора deal_events».
  const priceObjectionHiddenIds = [
    'stage_price_lower_denom_primary', 'stage_price_lower_denom_repeat',
    'stage_price_lower_to_reservation_num_primary', 'stage_price_lower_to_reservation_num_repeat',
    'stage_price_lower_to_sale_num_primary', 'stage_price_lower_to_sale_num_repeat',
    'stage_price_lower_to_lost_num_primary', 'stage_price_lower_to_lost_num_repeat',
  ];
  const hasPriceObjectionMetric = withDeps.some(m => priceObjectionHiddenIds.includes(m.id));

  if (hasPriceObjectionMetric && reportSlug === 'by-managers') {
    const [curPO, compPO] = await Promise.all([
      fetchPriceObjectionConversion(opts.period),
      fetchPriceObjectionConversion(compOpts.period),
    ]);

    const enrichPriceObjection = (
      row: ReportRow,
      po: Awaited<ReturnType<typeof fetchPriceObjectionConversion>>,
    ): ReportRow => {
      const p = po?.get(row.dimensionId);
      return {
        ...row,
        metrics: {
          ...row.metrics,
          stage_price_lower_denom_primary: po ? (p?.denomPrimary ?? 0) : null,
          stage_price_lower_denom_repeat: po ? (p?.denomRepeat ?? 0) : null,
          stage_price_lower_to_reservation_num_primary: po ? (p?.numReservationPrimary ?? 0) : null,
          stage_price_lower_to_reservation_num_repeat: po ? (p?.numReservationRepeat ?? 0) : null,
          stage_price_lower_to_sale_num_primary: po ? (p?.numSalePrimary ?? 0) : null,
          stage_price_lower_to_sale_num_repeat: po ? (p?.numSaleRepeat ?? 0) : null,
          stage_price_lower_to_lost_num_primary: po ? (p?.numLostPrimary ?? 0) : null,
          stage_price_lower_to_lost_num_repeat: po ? (p?.numLostRepeat ?? 0) : null,
        },
      };
    };
    currentRows = currentRows.map(r => enrichPriceObjection(r, curPO));
    compRows = compRows.map(r => enrichPriceObjection(r, compPO));
  }

  // КОЛСТАТ — метрики каталога «Звонки» (va.calls, задача 10.07, owners-inbox) —
  // тот же гейт, что и активность/конверсии стадий выше: только by-managers
  // (атрибуция звонковых метрик — calls.manager_id, сделочных — d.current_manager_id,
  // обе — менеджерские измерения, для by-product-groups/by-sources ключи просто
  // отсутствуют → computeCalculated по цепочке зависимостей отдаёт null).
  const callsMetricIds = [
    'calls_count', 'calls_count_repeat', 'calls_count_all',
    'calls_duration_out', 'calls_duration_out_repeat', 'calls_duration_out_all',
    'calls_duration_in', 'calls_duration_in_repeat', 'calls_duration_in_all',
    'calls_completed_duration_sum', 'calls_completed_duration_sum_repeat', 'calls_completed_duration_sum_orphan',
    'calls_completed_count', 'calls_completed_count_repeat', 'calls_completed_count_orphan',
    'calls_avg_duration', 'calls_avg_duration_repeat', 'calls_avg_duration_all',
    'calls_median_duration', 'calls_median_duration_repeat', 'calls_median_duration_all',
    'calls_first_call_duration_median', 'calls_first_call_duration_median_repeat', 'calls_first_call_duration_median_all',
    'calls_touch_speed_median', 'calls_touch_speed_median_repeat', 'calls_touch_speed_median_all',
    'calls_to_reservation_num', 'calls_to_reservation_num_repeat',
    'calls_to_reservation_denom', 'calls_to_reservation_denom_repeat',
    'calls_to_reservation_avg', 'calls_to_reservation_avg_repeat', 'calls_to_reservation_avg_all',
    'calls_missed_outbound', 'calls_missed_outbound_repeat', 'calls_missed_outbound_orphan',
    'calls_outbound_total', 'calls_outbound_total_repeat', 'calls_outbound_total_orphan',
    'calls_missed_rate', 'calls_missed_rate_repeat', 'calls_missed_rate_all',
    'calls_deals_no_call', 'calls_deals_no_call_repeat', 'calls_deals_no_call_all',
    'calls_silence_deals', 'calls_silence_deals_repeat', 'calls_silence_deals_all',
  ];
  const hasCallsMetric = withDeps.some(m => callsMetricIds.includes(m.id));

  if (hasCallsMetric && reportSlug === 'by-managers') {
    const [curBase, curAdditive, curTouch, curSilence, compBase, compAdditive, compTouch, compSilence] = await Promise.all([
      fetchCallsBaseMetrics(opts.period),
      fetchDealCallAdditive(opts.period),
      fetchTouchAndFirstCallMedians(opts.period),
      fetchCallSilence(opts.period.to),
      fetchCallsBaseMetrics(compOpts.period),
      fetchDealCallAdditive(compOpts.period),
      fetchTouchAndFirstCallMedians(compOpts.period),
      fetchCallSilence(compOpts.period.to),
    ]);

    const round1 = (n: number) => Math.round(n * 10) / 10;
    const zeroBucket: Bucket = { primary: 0, repeat: 0, all: 0 };
    // «Сирота» (звонок без своей sa.deals) = rollup «(все)» минус перв. минус повт. —
    // rollup строится ТЕМ ЖЕ GROUP BY, что и перв./повт. (GROUPING SETS), поэтому
    // равенство all = primary + repeat + orphan точное. НО: округляем primary/repeat
    // ДО вычитания (round1) — иначе плавающая ошибка деления duration_seconds/60
    // (перв./повт. — уже округлённые видимые значения, orphan вычисляется из НИХ ЖЕ)
    // даёт мусор вида 7.1e-15, а evalFormula (calculated.ts) не понимает
    // экспоненциальную запись в подставленном числе → формула «(все)» молча
    // становится null (живая проверка 10.07 поймала это на реальных цифрах).
    const orphanOf = (b: Bucket) => round1(b.all) - round1(b.primary) - round1(b.repeat);

    const enrichCalls = (
      row: ReportRow,
      base: Map<string, CallsBaseRow> | null,
      additive: Map<string, DealCallAdditiveRow> | null,
      touch: Map<string, TouchAndFirstCallRow> | null,
      silence: Map<string, Bucket> | null,
    ): ReportRow => {
      const b = base?.get(row.dimensionId);
      const bb: CallsBaseRow = b ?? {
        count: zeroBucket, outDurationMin: zeroBucket, inDurationMin: zeroBucket,
        completedDurationSumMin: zeroBucket, completedCount: zeroBucket, medianDurationMin: zeroBucket,
        outboundCount: zeroBucket, missedOutboundCount: zeroBucket,
      };
      const a = additive?.get(row.dimensionId);
      const aa: DealCallAdditiveRow = a ?? { dealsNoCalls: zeroBucket, dealsWithReservation: zeroBucket, callsBeforeReservationSum: zeroBucket };
      const t = touch?.get(row.dimensionId);
      const tt: TouchAndFirstCallRow = t ?? { medianTouchMinutes: zeroBucket, medianFirstCallDurationMin: zeroBucket };
      const ss = silence?.get(row.dimensionId) ?? zeroBucket;

      const metrics: Record<string, number | null> = {
        // 1. Кол-во звонков — прямые external (сумма — корректно бьётся в «Итого»)
        calls_count: base ? bb.count.primary : null,
        calls_count_repeat: base ? bb.count.repeat : null,
        calls_count_all: base ? bb.count.all : null,
        // 2/3. Длительность исходящих/входящих, мин — прямые external
        calls_duration_out: base ? round1(bb.outDurationMin.primary) : null,
        calls_duration_out_repeat: base ? round1(bb.outDurationMin.repeat) : null,
        calls_duration_out_all: base ? round1(bb.outDurationMin.all) : null,
        calls_duration_in: base ? round1(bb.inDurationMin.primary) : null,
        calls_duration_in_repeat: base ? round1(bb.inDurationMin.repeat) : null,
        calls_duration_in_all: base ? round1(bb.inDurationMin.all) : null,
        // Служебные (числитель/знаменатель средней длительности, метрика 4) — сумма,
        // корректно бьётся в «Итого» → «(все)» пересчитывается из сумм, а не как
        // среднее двух средних. round1 ОБЯЗАТЕЛЕН и здесь (не только на видимых) —
        // без него orphan = all-primary-repeat даёт плавающий мусор вида 7.1e-15
        // (деление duration_seconds/60), а evalFormula (calculated.ts) не понимает
        // экспоненциальную запись в подставленном числе → вся формула «(все)» молча
        // становится null. Живая проверка 10.07 поймала это на реальных цифрах.
        calls_completed_duration_sum: base ? round1(bb.completedDurationSumMin.primary) : null,
        calls_completed_duration_sum_repeat: base ? round1(bb.completedDurationSumMin.repeat) : null,
        calls_completed_duration_sum_orphan: base ? round1(orphanOf(bb.completedDurationSumMin)) : null,
        calls_completed_count: base ? bb.completedCount.primary : null,
        calls_completed_count_repeat: base ? bb.completedCount.repeat : null,
        calls_completed_count_orphan: base ? orphanOf(bb.completedCount) : null,
        // 5. Медианная длительность — прямая (percentile_cont), не суммируется в «Итого»
        calls_median_duration: base ? round1(bb.medianDurationMin.primary) : null,
        calls_median_duration_repeat: base ? round1(bb.medianDurationMin.repeat) : null,
        calls_median_duration_all: base ? round1(bb.medianDurationMin.all) : null,
        // Служебные (недозвоны, метрика 9) — сумма
        calls_missed_outbound: base ? bb.missedOutboundCount.primary : null,
        calls_missed_outbound_repeat: base ? bb.missedOutboundCount.repeat : null,
        calls_missed_outbound_orphan: base ? orphanOf(bb.missedOutboundCount) : null,
        calls_outbound_total: base ? bb.outboundCount.primary : null,
        calls_outbound_total_repeat: base ? bb.outboundCount.repeat : null,
        calls_outbound_total_orphan: base ? orphanOf(bb.outboundCount) : null,
        // 6. Длительность первого разговора сделки (медиана) — прямая, не суммируется
        calls_first_call_duration_median: touch ? round1(tt.medianFirstCallDurationMin.primary) : null,
        calls_first_call_duration_median_repeat: touch ? round1(tt.medianFirstCallDurationMin.repeat) : null,
        calls_first_call_duration_median_all: touch ? round1(tt.medianFirstCallDurationMin.all) : null,
        // 7. Скорость первого касания (медиана) — прямая, не суммируется
        calls_touch_speed_median: touch ? round1(tt.medianTouchMinutes.primary) : null,
        calls_touch_speed_median_repeat: touch ? round1(tt.medianTouchMinutes.repeat) : null,
        calls_touch_speed_median_all: touch ? round1(tt.medianTouchMinutes.all) : null,
        // Служебные (звонков до брони, метрика 8) — сумма; у сделки funnel_id
        // резолвится всегда, «сирот» здесь нет
        calls_to_reservation_num: additive ? aa.callsBeforeReservationSum.primary : null,
        calls_to_reservation_num_repeat: additive ? aa.callsBeforeReservationSum.repeat : null,
        calls_to_reservation_denom: additive ? aa.dealsWithReservation.primary : null,
        calls_to_reservation_denom_repeat: additive ? aa.dealsWithReservation.repeat : null,
        // 10. Сделки без звонка — прямая сумма
        calls_deals_no_call: additive ? aa.dealsNoCalls.primary : null,
        calls_deals_no_call_repeat: additive ? aa.dealsNoCalls.repeat : null,
        calls_deals_no_call_all: additive ? aa.dealsNoCalls.all : null,
        // 11. «Тишина» — снимок на period.to (см. fetchCallSilence), прямая сумма
        calls_silence_deals: silence ? ss.primary : null,
        calls_silence_deals_repeat: silence ? ss.repeat : null,
        calls_silence_deals_all: silence ? ss.all : null,
      };
      return { ...row, metrics: { ...row.metrics, ...metrics } };
    };
    currentRows = currentRows.map(r => enrichCalls(r, curBase, curAdditive, curTouch, curSilence));
    compRows = compRows.map(r => enrichCalls(r, compBase, compAdditive, compTouch, compSilence));
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
