import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadMetrics, resolveMetricIds, withDependencies } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { fetchByProductGroups } from '@/features/reports/engine/byProductGroups';
import { fetchBySources } from '@/features/reports/engine/bySources';
import { fetchManagerActivity, getCalendarWorkingDaysInPeriod } from '@/features/reports/engine/managerActivity';
import { fetchBookingCallRate } from '@/features/reports/engine/bookingCallRate';
import { fetchStageConversions, STAGE_PAIRS, type StageConversionRow } from '@/features/reports/engine/stageConversions';
import { fetchPriceObjectionConversion } from '@/features/reports/engine/priceObjectionConversion';
import { fetchCalledConversion, CALLED_CONVERSION_HIDDEN_IDS } from '@/features/reports/engine/calledConversion';
import { fetchStageEntered, STAGE_ENTERED_GROUP_KEYS, STAGE_ENTERED_METRIC_IDS, stageEnteredMetricIds } from '@/features/reports/engine/stageEntered';
import {
  fetchCallsBaseMetrics, fetchDealCallAdditive, fetchTouchAndFirstCallMedians, fetchCallSilence,
  GRAND_TOTAL_KEY,
  type Bucket, type CallsBaseRow, type DealCallAdditiveRow, type TouchAndFirstCallRow,
} from '@/features/reports/engine/callsMetrics';
import { computeRatingValues } from '@/features/manager-card/engine/ratings';
import { computeCalculated, computeTotals, computeDelta } from '@/features/reports/engine/calculated';
import { applyGrouping } from '@/features/reports/engine/grouping';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { getWorkingDaysByMonthInRange } from '@/lib/plans/dailyPlan';
import { periodDateStr } from '@/lib/period';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { DealScope, ClientType, Grouping, ReportRow, ProductGroupMode, AccountType, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';

interface PeriodPlanEntry { planSales: number; planShipments: number }

/**
 * Валидация period/comparisonPeriod (баг найден 10.07 при работе над задачей "план
 * (на сегодня)"): при отсутствующем/битом comparisonPeriod (например, клиент не передал
 * поле вовсе) `comparisonPeriod.from` в compOpts падал с TypeError на undefined —
 * необработанное исключение отдавало 500 вместо честной 400-валидации. Проверяем оба
 * периода одинаково (симметрично), т.к. `period` тоже может прийти пустым/битым.
 */
function isValidPeriodInput(p: unknown): p is { from: string; to: string } {
  if (!p || typeof p !== 'object') return false;
  const from = (p as Record<string, unknown>).from;
  const to = (p as Record<string, unknown>).to;
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  return !Number.isNaN(new Date(from).getTime()) && !Number.isNaN(new Date(to).getTime());
}

/**
 * Задача 10.07 (фикс «план-метрики должны считать рабочие дни ПО ВЫБРАННОМУ ПЕРИОДУ, а не
 * по "сегодня"» — owners-inbox). Раньше «План (на сегодня)» и «Выполнение плана % (день)/
 * (неделя)» считались от начала ТЕКУЩЕГО календарного месяца/недели до реального "сегодня",
 * полностью игнорируя выбранный период отчёта (баг: период 01-08.07 при сегодня=10.07 давал
 * план за 8 будней вместо 6-в-периоде).
 *
 * Новая семантика: рабочие дни = будни (пн-пт) в пересечении
 * [periodFromStr, min(periodToStrRaw, сегодня МСК)]. План = дневной_план (месячный ÷ 20,
 * режим как есть, см. lib/plans/dailyPlan) × эти дни, отдельно по КАЖДОМУ месяцу периода —
 * если период переходит границу месяца, дни каждого месяца берут дневной план ИМЕННО
 * своего месяца (план месяца из manager_plans этого месяца). Если плана на какой-то месяц
 * периода нет — этот месяц просто пропускается (план по имеющимся месяцам), а не обнуляет
 * весь расчёт.
 */
async function computePeriodPlanByLogin(
  periodFromStr: string,
  periodToStrRaw: string,
  mskTodayStr: string,
): Promise<{ byLogin: Map<string, PeriodPlanEntry>; rangeToStr: string }> {
  const rangeToStr = periodToStrRaw < mskTodayStr ? periodToStrRaw : mskTodayStr;
  if (rangeToStr < periodFromStr) {
    // Период целиком в будущем (ещё не начался к "сегодня") — рабочих дней 0, план 0 у всех.
    return { byLogin: new Map(), rangeToStr };
  }

  const chunks = await getWorkingDaysByMonthInRange(periodFromStr, rangeToStr);
  if (chunks.length === 0) return { byLogin: new Map(), rangeToStr };

  const months = chunks.map(c => c.month);
  const sysDb = systemDb();
  const plansRes = await sysDb.query<{ manager_login: string; month: string; plan_shipments: string; plan_n: string }>(
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
      if (!mp) continue; // плана на этот месяц периода нет — считаем по имеющимся
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

/**
 * Суммы продаж/отгрузок по менеджерам за ФИКСИРОВАННОЕ окно дат (МСК), для процентов
 * «(дневной)» / «(на текущий день)» / «(месяц)» — миграция 146. Окно задаётся датами
 * YYYY-MM-DD включительно и НЕ зависит от периода отчёта: «сегодня» и «месяц» должны
 * оставаться собой, какой бы период ни выбрал пользователь.
 *
 * Тот же приём, что features/manager-card/engine/planFact.ts: buildCollectedSQL по
 * primary+repeat суммам, границы — московская полночь (fromZonedTime), поэтому «день»
 * это рабочий день менеджера, а не сутки UTC.
 */
async function fetchPlanFactWindow(
  fromDateStr: string,
  toDateStr: string,
): Promise<Map<string, { sales: number; shipments: number }>> {
  const IDS = ['primary_sales_amount', 'repeat_sales_amount', 'primary_shipments_amount', 'repeat_shipments_amount'];
  const all = await loadMetrics();
  const metrics = all.filter(m => IDS.includes(m.id));
  const sql = buildCollectedSQL(metrics, {
    idExpr: 'd.current_manager_id::text',
    groupBy: 'GROUP BY d.current_manager_id',
    notNullWhere: 'd.current_manager_id IS NOT NULL',
  });
  const out = new Map<string, { sales: number; shipments: number }>();
  if (!sql) return out;

  const fromIso = fromZonedTime(`${fromDateStr} 00:00:00`, 'Europe/Moscow').toISOString();
  const toExclDate = new Date(`${toDateStr}T00:00:00Z`);
  toExclDate.setUTCDate(toExclDate.getUTCDate() + 1);
  const toExclIso = fromZonedTime(`${toExclDate.toISOString().slice(0, 10)} 00:00:00`, 'Europe/Moscow').toISOString();

  const res = await analyticsDb().query<Record<string, unknown> & { dimension_id: string }>(sql, [fromIso, toExclIso]);
  const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  for (const row of res.rows) {
    out.set(row.dimension_id, {
      sales: num(row.primary_sales_amount) + num(row.repeat_sales_amount),
      shipments: num(row.primary_shipments_amount) + num(row.repeat_shipments_amount),
    });
  }
  return out;
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
    productGroupIds, // раздел «Графики» (мультиселект, задача 29.07): пустой/undefined = все группы
    sourceDimension, // by-sources: main dimension (brand/platform/contact_type/ad_channel/branch/source)
    sourceFilter,    // drilldown: { dimension, value } — restrict deals to one dimension value
    // Задача 1569: экспериментальные фильтры по нерабочему времени (сегментация,
    // НЕ персистится в SavedReport — см. FiltersMenu.tsx/SalesReportPage.tsx).
    createdTimeFilter = 'all' as CreatedTimeFilter,
    firstTouchFilter = 'all' as FirstTouchFilter,
  } = body;

  if (!isValidPeriodInput(period)) {
    return NextResponse.json({ error: 'period.from и period.to обязательны и должны быть валидными датами' }, { status: 400 });
  }
  if (!isValidPeriodInput(comparisonPeriod)) {
    return NextResponse.json({ error: 'comparisonPeriod.from и comparisonPeriod.to обязательны и должны быть валидными датами' }, { status: 400 });
  }
  // productGroupIds — новый мультиселект (раздел «Графики», задача 29.07): массив
  // строк, элементы валидируются движком (byManagers.ts/byProductGroups.ts →
  // productGroupFilter.ts, параметризованный SQL). Здесь — только форма/размер.
  if (productGroupIds !== undefined && (!Array.isArray(productGroupIds) || productGroupIds.length > 200 || productGroupIds.some((v: unknown) => typeof v !== 'string' || v.length > 200))) {
    return NextResponse.json({ error: 'productGroupIds должен быть массивом строк (макс. 200 элементов, каждая ≤200 символов)' }, { status: 400 });
  }

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
    createdTimeFilter,
    firstTouchFilter,
  };
  const compOpts = {
    period: { from: new Date(comparisonPeriod.from), to: new Date(comparisonPeriod.to) },
    dealScope,
    clientType,
    departmentIds,
    accountType,
    createdTimeFilter,
    firstTouchFilter,
  };

  // Задача 10.07/1595: общие для обеих групп план-метрик даты — "сегодня" МСК и
  // календарные границы текущего/сравнительного периода.
  //
  // БАГ (найден по скрину владельца, «План (на сегодня)» = 812 500 у #2001 при верных
  // 656 250 у #2002 в ТОМ ЖЕ отчёте): UI (SalesReportPage) сериализует period как
  // `Date.toISOString()`. Для браузера в МСК полночь 01.07 МСК — это
  // `2026-06-30T21:00:00.000Z`, и прежний `new Date(...).toISOString().slice(0,10)`
  // давал «2026-06-30» — период планов расширялся на 30.06 (будний день!), и менеджеры,
  // у которых ЕСТЬ план на июнь, получали лишний июньский день (156 250 у #2001 →
  // 656 250 + 156 250 = 812 500), а у кого июньского плана нет (#2002) — число «случайно»
  // оставалось верным. Прямые curl-репродукции бага не ловили: они слали date-only
  // строки («2026-07-01»), у которых UTC-дата совпадает с календарной.
  //
  // Однако «просто конвертировать в МСК» тоже нельзя: браузер НЕ в МСК шлёт
  // «MSK-псевдо-UTC» (локальная полночь его пояса, see lib/period::msk()) — для него
  // конец дня приходит как `...T23:59:59.999Z`, и МСК-конвертация сдвинула бы `to` на
  // день ВПЕРЁД. Обе семьи клиентов (настоящий UTC-инстант из МСК-браузера и псевдо-UTC
  // из любого другого пояса) объединяет одно: `from` — это полночь НУЖНОЙ календарной
  // даты в каком-то поясе, `to` — конец дня нужной даты. Поэтому «полуденный» приём:
  // from + 12ч и to − 12ч попадают внутрь нужных суток при любом поясе клиента из
  // (-12..+12] (экзотика +13/+14 — Кирибати/NZDT — вне зоны пользователей). Голая
  // date-only строка (API-клиенты, curl) берётся буквально, без Date-роундтрипа.
  // periodDateStr вынесен в lib/period (задача 1610) — используется и здесь, и в
  // движках отчётов (managerActivity.ts и др., через Date-вариант periodDateStrFromInstant).
  const MSK_TZ = 'Europe/Moscow';
  // formatInTimeZone вместо toZonedTime().toISOString(): прод-хост живёт в MSK, а
  // toZonedTime сдвигает дату в расчёте на чтение ЛОКАЛЬНЫМИ геттерами — .toISOString()
  // (UTC-геттеры) на не-UTC хосте возвращал СЫРУЮ UTC-дату (в 00:00–02:59 МСК — вчерашнюю).
  const mskTodayStr = formatInTimeZone(new Date(), MSK_TZ, 'yyyy-MM-dd');
  const periodFromStr = periodDateStr(period.from, 'from');
  const periodToStr = periodDateStr(period.to, 'to');
  const compPeriodFromStr = periodDateStr(comparisonPeriod.from, 'from');
  const compPeriodToStr = periodDateStr(comparisonPeriod.to, 'to');

  let currentRows: ReportRow[] = [];
  let compRows: ReportRow[] = [];

  // «Итого» для медианных метрик звонков (задача 10.07, п.7) — заполняется внутри
  // блока КОЛСТАТ ниже (если запрошены), читается при сборке totals в самом конце.
  // Значение — уже НАСТОЯЩАЯ медиана по всей видимой совокупности (GRAND_TOTAL_KEY
  // из callsMetrics.ts), не сумма/среднее по строкам — computeTotals() эти метрики
  // сознательно пропускает (aggregation_fn='none', не аддитивны).
  let callsMedianGrandTotals: {
    curBase?: CallsBaseRow; compBase?: CallsBaseRow;
    curTouch?: TouchAndFirstCallRow; compTouch?: TouchAndFirstCallRow;
  } | null = null;

  if (reportSlug === 'by-managers') {
    [currentRows, compRows] = await Promise.all([
      fetchByManagers({ ...opts, productGroupMode, productGroupId, productGroupIds, sourceFilter }),
      fetchByManagers({ ...compOpts, productGroupMode, productGroupId, productGroupIds, sourceFilter }),
    ]);
  } else if (reportSlug === 'by-product-groups') {
    [currentRows, compRows] = await Promise.all([
      fetchByProductGroups({ period: opts.period, dealScope, clientType, productGroupMode, productGroupIds, managerId, departmentIds, createdTimeFilter, firstTouchFilter }),
      fetchByProductGroups({ period: compOpts.period, dealScope, clientType, productGroupMode, productGroupIds, managerId, departmentIds, createdTimeFilter, firstTouchFilter }),
    ]);
  } else if (reportSlug === 'by-sources') {
    [currentRows, compRows] = await Promise.all([
      fetchBySources({ period: opts.period, dealScope, clientType, sourceDimension, sourceFilter, createdTimeFilter, firstTouchFilter }),
      fetchBySources({ period: compOpts.period, dealScope, clientType, sourceDimension, sourceFilter, createdTimeFilter, firstTouchFilter }),
    ]);
  }

  // Fetch plan data for external metrics
  const planMetricIds = [
    'plan_sales_month', 'plan_shipments_month',
    'plan_sales_today', 'plan_shipments_today',
    'plan_sales_current_day', 'plan_shipments_current_day',
  ];
  const hasAnyPlanMetric = withDeps.some(m => planMetricIds.includes(m.id));

  if (hasAnyPlanMetric) {
    const monthsOf = (fromStr: string, toStr: string): string[] => {
      const months: string[] = [];
      const from = new Date(fromStr);
      const to = new Date(toStr);
      const cur = new Date(from.getFullYear(), from.getMonth(), 1);
      const end = new Date(to.getFullYear(), to.getMonth(), 1);
      while (cur <= end) {
        months.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
        cur.setMonth(cur.getMonth() + 1);
      }
      return months;
    };

    const sysDb = systemDb();

    // planByLoginFor(months) — «План (месяц)»: сумма месячных планов ВСЕХ месяцев,
    // затронутых периодом. БАГ, найден 10.07 (см. отчёт задачи «план на сегодня»):
    // раньше planByLogin строился ОДИН РАЗ из months текущего периода (period.from..to)
    // и переиспользовался ДЛЯ ОБОИХ enrichRow(currentRows) И enrichRow(compRows) — если
    // comparisonPeriod попадал в ДРУГОЙ календарный месяц (обычный случай — сравнение с
    // «хвостом прошлого месяца», см. lib/period::recomputeComparison), «План (месяц)»
    // и всё, что от него считается (calculated-метрики вида «% выполнения плана
    // (месяц)»), в КОЛОНКЕ СРАВНЕНИЯ показывали план ТЕКУЩЕГО месяца вместо месяца
    // сравниваемого периода. Живая проверка: период 01–09.07 (план июля 1 875 000) vs
    // авто-сравнение 22–30.06 (план июня 3 125 000) — plan_sales_month.comparison
    // ошибочно показывал 1 875 000 вместо 3 125 000. Фикс — строить planByLogin
    // ОТДЕЛЬНО для месяцев текущего периода и ОТДЕЛЬНО для месяцев периода сравнения
    // (симметрично тому, как уже сделано ниже для periodPlanCurrent/periodPlanComp).
    const loadPlanByLogin = async (fromStr: string, toStr: string): Promise<Map<string, { plan_shipments: number; plan_n: number }>> => {
      const months = monthsOf(fromStr, toStr);
      if (months.length === 0) return new Map();
      const plansRes = await sysDb.query<{ manager_login: string; month: string; plan_shipments: string; plan_n: string }>(
        `SELECT manager_login, to_char(month, 'YYYY-MM') as month, plan_shipments, plan_n
         FROM manager_plans WHERE to_char(month, 'YYYY-MM') = ANY($1)`,
        [months]
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
      return planByLogin;
    };

    // ПЕРЕОПРЕДЕЛЕНИЕ 14.07 (задача Иосифа): «План (на сегодня)» = «План (месяц)» ÷ 20 —
    // константный дневной план, БЕЗ накопления по периоду (прежняя период-накопительная
    // семантика жила здесь с задачи 10.07; computePeriodPlanByLogin ниже сохраняется —
    // на нём по-прежнему считаются «Выполнение плана % (день)/(неделя)»).
    // Новые «План (на тек. день)» = дневной × порядковый номер рабочего дня СЕГОДНЯ
    // (МСК) в текущем месяце ПО ПРОИЗВОДСТВЕННОМУ КАЛЕНДАРЮ (working_calendar,
    // getCalendarWorkingDaysInPeriod — не зависит от режима ÷20). В нерабочий день
    // номер = числу прошедших рабочих дней месяца.
    // DateRange для getCalendarWorkingDaysInPeriod: полночь/конец дня UTC — тогда
    // «полуденный» приём periodDateStrFromInstant внутри вернёт ровно эти даты.
    // null (календарь не заполнен на месяц) → «(на тек. день)» честно null.
    const mskMonthStartStr = `${mskTodayStr.slice(0, 7)}-01`;
    // Понедельник текущей недели (МСК) — для «(на текущий день недели)», миграция 147.
    const mskWeekStartStr = (() => {
      const d = new Date(`${mskTodayStr}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
    const [planByLoginCurrent, planByLoginComp, workdayNum, weekWorkdayNum] = await Promise.all([
      loadPlanByLogin(periodFromStr, periodToStr),
      loadPlanByLogin(compPeriodFromStr, compPeriodToStr),
      getCalendarWorkingDaysInPeriod({
        from: new Date(`${mskMonthStartStr}T00:00:00.000Z`),
        to: new Date(`${mskTodayStr}T23:59:59.999Z`),
      }),
      getCalendarWorkingDaysInPeriod({
        from: new Date(`${mskWeekStartStr}T00:00:00.000Z`),
        to: new Date(`${mskTodayStr}T23:59:59.999Z`),
      }),
    ]);

    const enrichRow = (
      row: ReportRow,
      planByLogin: Map<string, { plan_shipments: number; plan_n: number }>,
    ): ReportRow => {
      const login = row.dimensionSubtitle;
      const plan = login ? planByLogin.get(login) : undefined;
      if (!plan) return row;
      const planSalesMonth = plan.plan_shipments / plan.plan_n;
      const planShipmentsMonth = plan.plan_shipments;
      const dailySales = planSalesMonth / 20;
      const dailyShipments = planShipmentsMonth / 20;
      return {
        ...row,
        metrics: {
          ...row.metrics,
          plan_sales_month: planSalesMonth,
          plan_shipments_month: planShipmentsMonth,
          plan_sales_today: dailySales,
          plan_shipments_today: dailyShipments,
          plan_sales_current_day: workdayNum == null ? null : dailySales * workdayNum,
          plan_shipments_current_day: workdayNum == null ? null : dailyShipments * workdayNum,
          // «(на текущий день недели)» — та же формула, окно [понедельник, сегодня]
          plan_sales_current_week_day: weekWorkdayNum == null ? null : dailySales * weekWorkdayNum,
          plan_shipments_current_week_day: weekWorkdayNum == null ? null : dailyShipments * weekWorkdayNum,
        }
      };
    };
    // Дорисовка строк (баг 15.07, скрин Иосифа: «Итого План (на сегодня)» менялось от
    // периода — 9 218 750 за 01–14.07 против 7 750 000 за 15.07): строки отчёта
    // «по менеджерам» строятся ИЗ СДЕЛОК периода, и менеджер с планом, но без сделок,
    // выпадал из таблицы вместе со своим планом. Теперь при запрошенных план-метриках
    // такие менеджеры добавляются пустыми строками (план-метрики заполнит enrichRow
    // ниже, остальное — null). Фильтры отделов/типа аккаунтов уважаются — той же
    // логикой, что в fetchByManagers (org_resolved_hierarchy + departments + employees).
    if (reportSlug === 'by-managers') {
      const appendPlanOnlyRows = async (rows: ReportRow[], planByLogin: Map<string, { plan_shipments: number; plan_n: number }>) => {
        const present = new Set(rows.map(r => r.dimensionSubtitle).filter(Boolean));
        const missing = [...planByLogin.keys()].filter(l => !present.has(l));
        if (missing.length === 0) return rows;
        // Оргструктура — из sa (analyticsDb), НЕ из YC system: синк с 13.07
        // пишет только в sa, YC-копия протухла (задача 2065, тот же фикс, что в
        // byManagers.ts/byProductGroups.ts). employees остаётся в system.
        const [org, allowed, logins] = await Promise.all([
          analyticsDb().query<{ short_login: string; bitrix_user_id: string; manager_name: string; department_id: string | null; department_name: string | null; branch: string | null }>(
            `SELECT short_login, manager_bitrix_user_id AS bitrix_user_id, manager_name,
                    department_id, department_name, branch
             FROM sa.org_resolved_hierarchy WHERE is_active AND short_login = ANY($1)`,
            [missing]
          ),
          (departmentIds?.length
            ? analyticsDb().query<{ bitrix_user_id: string }>(
                `SELECT DISTINCT manager_bitrix_user_id::text AS bitrix_user_id
                 FROM sa.org_resolved_hierarchy orh
                 WHERE orh.department_id IN (
                   SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($1)
                 ) AND orh.is_active`,
                [departmentIds]
              )
            : Promise.resolve(null)),
          (accountType !== 'all'
            ? sysDb.query<{ bitrix_user_id: string; bitrix_login: string | null }>(
                `SELECT bitrix_user_id::text AS bitrix_user_id, bitrix_login FROM employees WHERE is_active = true`
              )
            : Promise.resolve(null)),
        ]);
        const allowedSet = allowed ? new Set(allowed.rows.map(r => r.bitrix_user_id)) : null;
        const loginByBitrix = logins ? new Map(logins.rows.map(r => [r.bitrix_user_id, (r.bitrix_login ?? '').toLowerCase()])) : null;
        const accountPrefix = accountType === 'managers' ? 'manager' : accountType === 'logists' ? 'logist' : null;
        for (const o of org.rows) {
          if (allowedSet && !allowedSet.has(o.bitrix_user_id)) continue;
          if (accountPrefix && loginByBitrix && !(loginByBitrix.get(o.bitrix_user_id) ?? '').startsWith(accountPrefix)) continue;
          rows.push({
            dimensionId: o.bitrix_user_id,
            dimensionName: o.manager_name ?? o.short_login,
            dimensionSubtitle: o.short_login,
            teamId: o.department_id,
            teamName: o.department_name,
            branchName: o.branch ?? 'СПб',
            metrics: {},
          });
        }
        return rows;
      };
      [currentRows, compRows] = await Promise.all([
        appendPlanOnlyRows(currentRows, planByLoginCurrent),
        appendPlanOnlyRows(compRows, planByLoginComp),
      ]);
    }

    currentRows = currentRows.map(r => enrichRow(r, planByLoginCurrent));
    compRows = compRows.map(r => enrichRow(r, planByLoginComp));
  }

  // Метрики «Выполнение плана продаж/отгрузок, % (день)/(неделя)» — задача 10.07 (фикс
  // «план по периоду, не по сегодня»). Работают только в отчёте «по менеджерам» (планы
  // есть только у менеджеров/отделов).
  //
  // НОВАЯ семантика (было MTD/WTD от начала календарного месяца/недели до "сегодня",
  // игнорируя период отчёта):
  //   факт = факт ЗА ВЕСЬ ВЫБРАННЫЙ ПЕРИОД этой строки (currentRows уже посчитаны по
  //   opts.period, compRows — по compOpts.period; те же primary+repeat суммы уже лежат
  //   в row.metrics — дополнительный запрос не нужен);
  //   план = тот же «план на период» (рабочие дни периода∩сегодня × дневной план своего
  //   месяца), что и у «План (на сегодня)» выше (computePeriodPlanByLogin), — свой у
  //   current, свой у comparison.
  // Побочный эффект фикса: «день» и «неделя» после этого математически СОВПАДАЮТ (оба =
  // факт периода / план периода) — раньше отличались, т.к. один мерил MTD, другой WTD
  // (разные окна). Владелец просил день = факт/план периода, неделю — "аналогично, по
  // буднями недель внутри периода"; при суммировании по дням план не зависит от того,
  // группируем мы дни по месяцам или по неделям (сумма одна и та же) — оставляем оба ID
  // метрик (обратная совместимость сохранённых отчётов), они просто дают одно число.
  // Решение зафиксировано явно (см. отчёт по задаче 10.07), не скрытая ошибка.
  // «(период)»: факт за выбранный период ÷ сумма дневных планов по будням периода.
  // Метрики «(неделя)» удалены миграцией 146 — они давали то же число, что «(день)»,
  // и были главной причиной путаницы («коллеги выбирают не очевидные метрики»).
  const periodRelativePlanMetricIds = [
    'plan_execution_pct_sales_day', 'plan_execution_pct_shipments_day',
  ];
  // «(дневной)» и «(на текущий день)» (миграция 146): факт СВОЕГО окна — за сегодня
  // и с 1 числа месяца по сегодня — не зависит от периода отчёта, поэтому считается
  // отдельными запросами, и только если такая метрика реально запрошена.
  const fixedWindowPlanMetricIds = [
    'plan_exec_pct_sales_daily', 'plan_exec_pct_sales_current_day',
    'plan_exec_pct_shipments_daily', 'plan_exec_pct_shipments_current_day',
    'plan_execution_pct', 'plan_execution_pct_shipments_month',
    'plan_exec_pct_sales_current_week_day', 'plan_exec_pct_shipments_current_week_day',
  ];
  const hasPeriodRelativePlanMetric = withDeps.some(m => periodRelativePlanMetricIds.includes(m.id));

  if (hasPeriodRelativePlanMetric && reportSlug === 'by-managers') {
    const [periodPlanCurrentPct, periodPlanCompPct] = await Promise.all([
      computePeriodPlanByLogin(periodFromStr, periodToStr, mskTodayStr),
      computePeriodPlanByLogin(compPeriodFromStr, compPeriodToStr, mskTodayStr),
    ]);

    const enrichPeriodRelative = (row: ReportRow, periodPlan: Map<string, PeriodPlanEntry>): ReportRow => {
      const login = row.dimensionSubtitle;
      const plan = login ? periodPlan.get(login) : undefined;
      if (!plan) return row; // плана на месяцы диапазона нет вообще — как и раньше, не трогаем строку

      // Факт = ВСЕ продажи/отгрузки (перв.+повт.) ЗА ПЕРИОД ЭТОЙ строки, решение Серёги
      // 08.07 16:57 (этап 5б, п.1) сохранено. primary_*/repeat_*_amount — collected-метрики,
      // всегда присутствуют в row.metrics независимо от запрошенных metricIds (см.
      // features/reports/engine/byManagers.ts).
      const salesFact = (row.metrics.primary_sales_amount ?? 0) + (row.metrics.repeat_sales_amount ?? 0);
      const shipmentsFact = (row.metrics.primary_shipments_amount ?? 0) + (row.metrics.repeat_shipments_amount ?? 0);

      return {
        ...row,
        metrics: {
          ...row.metrics,
          sales_fact_mtd: salesFact,
          shipments_fact_mtd: shipmentsFact,
          plan_sales_target_mtd: plan.planSales,
          plan_shipments_target_mtd: plan.planShipments,
        },
      };
    };
    currentRows = currentRows.map(r => enrichPeriodRelative(r, periodPlanCurrentPct.byLogin));
    compRows = compRows.map(r => enrichPeriodRelative(r, periodPlanCompPct.byLogin));
  }

  // ── Факты фиксированных окон для % (дневной)/(на текущий день)/(месяц) ──────────
  // Миграция 146: у каждого процента свой знаменатель И свой числитель. «(месяц)»
  // раньше делил факт ПЕРИОДА на месячный план — при недельном периоде это давало
  // бессмыслицу («неделя ÷ месяц»). Теперь окна честные и от периода отчёта не зависят.
  if (withDeps.some(m => fixedWindowPlanMetricIds.includes(m.id)) && reportSlug === 'by-managers') {
    const monthStartStr = `${mskTodayStr.slice(0, 7)}-01`;
    const weekStartStr = (() => {
      const d = new Date(`${mskTodayStr}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
    const [todayByMgr, monthByMgr, weekByMgr] = await Promise.all([
      fetchPlanFactWindow(mskTodayStr, mskTodayStr),
      fetchPlanFactWindow(monthStartStr, mskTodayStr),
      fetchPlanFactWindow(weekStartStr, mskTodayStr),
    ]);
    const enrichFixedWindows = (row: ReportRow): ReportRow => {
      const t = todayByMgr.get(row.dimensionId);
      const m = monthByMgr.get(row.dimensionId);
      const w = weekByMgr.get(row.dimensionId);
      return {
        ...row,
        metrics: {
          ...row.metrics,
          sales_fact_today: t?.sales ?? 0,
          shipments_fact_today: t?.shipments ?? 0,
          sales_fact_month: m?.sales ?? 0,
          shipments_fact_month: m?.shipments ?? 0,
          sales_fact_week: w?.sales ?? 0,
          shipments_fact_week: w?.shipments ?? 0,
        },
      };
    };
    // Оба набора строк получают ОДНИ И ТЕ ЖЕ фиксированные окна (сегодня/месяц) —
    // они не зависят от периода строки, поэтому сравнение по ним не имеет смысла
    // и в колонке «к прошлому периоду» такие метрики покажут нулевую дельту.
    currentRows = currentRows.map(enrichFixedWindows);
    compRows = compRows.map(enrichFixedWindows);
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

  // ── Метрика «Рейтинг» (manager_rating, миграция 108; задача владельца 30.07) ──
  // metric_type='external': значение не считается SQL-агрегатом, а приходит из
  // движка рейтинга (features/manager-card/engine/ratings.ts) — перцентильный
  // скоринг по осям ШАБЛОНА карточки требует пула всех менеджеров, поэтому
  // инъекция здесь, как у plan_*/activity-метрик, и только для «по менеджерам».
  // Оси/веса берутся из шаблона 'manager' — то же число, что в ЛК менеджера.
  if (withDeps.some(m => m.id === 'manager_rating') && reportSlug === 'by-managers') {
    const [curRatings, compRatings] = await Promise.all([
      computeRatingValues({ period: opts.period, clientType: opts.clientType }),
      computeRatingValues({ period: compOpts.period, clientType: compOpts.clientType }),
    ]);
    const enrichRating = (row: ReportRow, ratings: Map<string, number | null>): ReportRow => ({
      ...row,
      metrics: { ...row.metrics, manager_rating: ratings.get(row.dimensionId) ?? null },
    });
    currentRows = currentRows.map(r => enrichRating(r, curRatings));
    compRows = compRows.map(r => enrichRating(r, compRatings));
  }

  // «Доля прозвона броней / подтв. броней на след. рабочий день» (задача Иосифа 17.07,
  // migrations/104) — служебные числители/знаменатели, видимые метрики — calculated
  // num/denom*100. Смысл только у менеджеров (звонок атрибутируется сделке менеджера) —
  // инжектим ТОЛЬКО в by-managers, как activity/stageConv выше.
  const bookingCallHiddenIds = [
    'booking_call_reserved_denom', 'booking_call_reserved_num',
    'booking_call_confirmed_denom', 'booking_call_confirmed_num',
  ];
  const hasBookingCallMetric = withDeps.some(m => bookingCallHiddenIds.includes(m.id));

  if (hasBookingCallMetric && reportSlug === 'by-managers') {
    const [curBooking, compBooking] = await Promise.all([
      fetchBookingCallRate(opts.period),
      fetchBookingCallRate(compOpts.period),
    ]);

    const enrichBooking = (row: ReportRow, booking: Awaited<ReturnType<typeof fetchBookingCallRate>>): ReportRow => {
      // null (весь период раньше старта звонков) → метрики null по цепочке зависимостей.
      if (!booking) return row;
      const b = booking.get(row.dimensionId);
      return {
        ...row,
        metrics: {
          ...row.metrics,
          booking_call_reserved_denom: b?.reservedDenom ?? 0,
          booking_call_reserved_num: b?.reservedNum ?? 0,
          booking_call_confirmed_denom: b?.confirmedDenom ?? 0,
          booking_call_confirmed_num: b?.confirmedNum ?? 0,
        },
      };
    };
    currentRows = currentRows.map(r => enrichBooking(r, curBooking));
    compRows = compRows.map(r => enrichBooking(r, compBooking));
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

  // «Кол-во сделок в стадии X» за период (задача 28.07, migrations/107) — потоковая
  // пара к снимкам «Стадии (сейчас)»: впервые вошедшие в стадию в периоде, тройки
  // перв./повт./все. Тот же гейт (только by-managers) и тот же приём «null только
  // если весь период раньше старта сбора deal_events».
  const hasStageEnteredMetric = withDeps.some(m => STAGE_ENTERED_METRIC_IDS.includes(m.id));
  if (hasStageEnteredMetric && reportSlug === 'by-managers') {
    const [curSE, compSE] = await Promise.all([
      fetchStageEntered(opts.period),
      fetchStageEntered(compOpts.period),
    ]);

    const enrichStageEntered = (
      row: ReportRow,
      se: Awaited<ReturnType<typeof fetchStageEntered>>,
    ): ReportRow => {
      const s = se?.get(row.dimensionId);
      const metrics: Record<string, number | null> = {};
      for (const grp of STAGE_ENTERED_GROUP_KEYS) {
        const ids = stageEnteredMetricIds(grp);
        const c = s?.[grp];
        metrics[ids.primary] = se ? (c?.primary ?? 0) : null;
        metrics[ids.repeat] = se ? (c?.repeat ?? 0) : null;
        metrics[ids.all] = se ? ((c?.primary ?? 0) + (c?.repeat ?? 0)) : null;
      }
      return { ...row, metrics: { ...row.metrics, ...metrics } };
    };
    currentRows = currentRows.map(r => enrichStageEntered(r, curSE));
    compRows = compRows.map(r => enrichStageEntered(r, compSE));
  }

  // «CR Созвонился → Продажа» (задача 28.07, migrations/107) — калька с блока
  // priceObjection выше: только by-managers, null только если весь период раньше
  // старта сбора deal_events.
  const hasCalledConversionMetric = withDeps.some(m => CALLED_CONVERSION_HIDDEN_IDS.includes(m.id));
  if (hasCalledConversionMetric && reportSlug === 'by-managers') {
    const [curCC, compCC] = await Promise.all([
      fetchCalledConversion(opts.period),
      fetchCalledConversion(compOpts.period),
    ]);

    const enrichCalledConversion = (
      row: ReportRow,
      cc: Awaited<ReturnType<typeof fetchCalledConversion>>,
    ): ReportRow => {
      const c = cc?.get(row.dimensionId);
      return {
        ...row,
        metrics: {
          ...row.metrics,
          stage_called_denom_primary: cc ? (c?.denomPrimary ?? 0) : null,
          stage_called_denom_repeat: cc ? (c?.denomRepeat ?? 0) : null,
          stage_called_to_sale_num_primary: cc ? (c?.numSalePrimary ?? 0) : null,
          stage_called_to_sale_num_repeat: cc ? (c?.numSaleRepeat ?? 0) : null,
        },
      };
    };
    currentRows = currentRows.map(r => enrichCalledConversion(r, curCC));
    compRows = compRows.map(r => enrichCalledConversion(r, compCC));
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
    'calls_outgoing_count', 'calls_outgoing_count_repeat', 'calls_outgoing_count_all',
    'calls_incoming_count', 'calls_incoming_count_repeat', 'calls_incoming_count_all',
  ];
  const hasCallsMetric = withDeps.some(m => callsMetricIds.includes(m.id));

  if (hasCallsMetric && reportSlug === 'by-managers') {
    // Скоуп «Итого» медианных метрик (задача 10.07, п.7) — те же менеджеры, что уже
    // прошли фильтры отчёта (отдел/тип аккаунтов — applied внутри fetchByManagers,
    // currentRows/compRows их уже отражают): передаём dimensionId-список в фетчеры,
    // чтобы GRAND_TOTAL-ветка SQL считала медиану ТОЛЬКО по видимой совокупности
    // звонков/сделок, а не по всей компании целиком.
    const curManagerIds = currentRows.map(r => r.dimensionId);
    const compManagerIds = compRows.map(r => r.dimensionId);
    const [curBase, curAdditive, curTouch, curSilence, compBase, compAdditive, compTouch, compSilence] = await Promise.all([
      fetchCallsBaseMetrics(opts.period, curManagerIds),
      fetchDealCallAdditive(opts.period),
      fetchTouchAndFirstCallMedians(opts.period, curManagerIds),
      fetchCallSilence(opts.period.to),
      fetchCallsBaseMetrics(compOpts.period, compManagerIds),
      fetchDealCallAdditive(compOpts.period),
      fetchTouchAndFirstCallMedians(compOpts.period, compManagerIds),
      fetchCallSilence(compOpts.period.to),
    ]);

    callsMedianGrandTotals = {
      curBase: curBase?.get(GRAND_TOTAL_KEY), compBase: compBase?.get(GRAND_TOTAL_KEY),
      curTouch: curTouch?.get(GRAND_TOTAL_KEY), compTouch: compTouch?.get(GRAND_TOTAL_KEY),
    };

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
        outLinkedCount: zeroBucket, inLinkedCount: zeroBucket,
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
        // Кол-во исходящих/входящих ТОЛЬКО со связью со сделкой (задача 31.07);
        // «(все)» = перв.+повт. (сирот нет по определению).
        calls_outgoing_count: base ? bb.outLinkedCount.primary : null,
        calls_outgoing_count_repeat: base ? bb.outLinkedCount.repeat : null,
        calls_outgoing_count_all: base ? bb.outLinkedCount.all : null,
        calls_incoming_count: base ? bb.inLinkedCount.primary : null,
        calls_incoming_count_repeat: base ? bb.inLinkedCount.repeat : null,
        calls_incoming_count_all: base ? bb.inLinkedCount.all : null,
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

  // «Итого» для медианных метрик звонков (задача 10.07, п.7): computeTotals() их
  // сознательно НЕ считает (aggregation_fn='none' — не сумма, а percentile_cont не
  // аддитивен — среднее/сумма построчных медиан была бы математически неверна).
  // Раньше эти 9 id просто отсутствовали в totals (пустая строка «Итого» в UI).
  // Правильное значение — НАСТОЯЩАЯ медиана по ВСЕЙ совокупности звонков/сделок,
  // попавших в отчёт с его фильтрами (отдел/период/скоуп) — уже посчитана одним
  // агрегатным запросом (GROUPING SETS, см. GRAND_TOTAL_KEY в callsMetrics.ts) и
  // передана сюда через callsMedianGrandTotals, без единого дополнительного запроса.
  if (callsMedianGrandTotals) {
    const { curBase, compBase, curTouch, compTouch } = callsMedianGrandTotals;
    const medianTotalDefs: { id: string; bucket: keyof Bucket; cur?: Bucket; comp?: Bucket }[] = [
      { id: 'calls_median_duration',        bucket: 'primary', cur: curBase?.medianDurationMin,  comp: compBase?.medianDurationMin },
      { id: 'calls_median_duration_repeat', bucket: 'repeat',  cur: curBase?.medianDurationMin,  comp: compBase?.medianDurationMin },
      { id: 'calls_median_duration_all',    bucket: 'all',     cur: curBase?.medianDurationMin,  comp: compBase?.medianDurationMin },
      { id: 'calls_touch_speed_median',        bucket: 'primary', cur: curTouch?.medianTouchMinutes, comp: compTouch?.medianTouchMinutes },
      { id: 'calls_touch_speed_median_repeat', bucket: 'repeat',  cur: curTouch?.medianTouchMinutes, comp: compTouch?.medianTouchMinutes },
      { id: 'calls_touch_speed_median_all',    bucket: 'all',     cur: curTouch?.medianTouchMinutes, comp: compTouch?.medianTouchMinutes },
      { id: 'calls_first_call_duration_median',        bucket: 'primary', cur: curTouch?.medianFirstCallDurationMin, comp: compTouch?.medianFirstCallDurationMin },
      { id: 'calls_first_call_duration_median_repeat', bucket: 'repeat',  cur: curTouch?.medianFirstCallDurationMin, comp: compTouch?.medianFirstCallDurationMin },
      { id: 'calls_first_call_duration_median_all',    bucket: 'all',     cur: curTouch?.medianFirstCallDurationMin, comp: compTouch?.medianFirstCallDurationMin },
    ];
    for (const def of medianTotalDefs) {
      if (!withDeps.some(m => m.id === def.id)) continue; // метрика не запрошена в этом вызове
      const current = def.cur ? def.cur[def.bucket] : null;
      const comparison = def.comp ? def.comp[def.bucket] : null;
      totals[def.id] = { current, comparison, ...computeDelta(current, comparison) };
    }
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
