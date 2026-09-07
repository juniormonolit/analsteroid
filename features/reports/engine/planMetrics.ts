import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { getWorkingDaysByMonthInRange } from '@/lib/plans/dailyPlan';
import { getCalendarWorkingDaysInPeriod } from './managerActivity';
import { buildCommonDealWhere, type CommonDealFilterOpts } from './commonDealWhere';
import { fromZonedTime } from 'date-fns-tz';
import type { Metric, ReportRow, AccountType } from '@/lib/metrics/types';

// ── Плановые метрики отчёта по менеджерам ─────────────────────────────────────
//
// Движок «планов» вынесен из app/api/reports/run/route.ts ДОСЛОВНО (07.09): строки
// fetchByManagers план-метрик не содержат — «План продаж (месяц/дневной/на текущий
// день/на текущий день недели)», «План (период)» + факты периода для «% (день)»,
// факты фиксированных окон (сегодня/неделя/месяц) дорисовываются здесь. До выноса
// это умел только роут отчёта, и конструктор «Мой отчёт» (/api/my-report),
// суммируя строки fetchByManagers через computeTotals, показывал у планов «0,0 млн»
// при заданных планах (жалоба владельца 07.09). Теперь оба роута зовут одну функцию —
// цифры совпадают по построению. Семантика окон, переопределения 10.07/14.07/31.08
// и все комментарии сохранены как были.

export interface PeriodPlanEntry { planSales: number; planShipments: number }

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
  // Сделочные фильтры отчёта (аудит 31.08): факты «% выполнения плана» фикс.
  // окон режутся так же, как основной отчёт. ПЛАН при этом не режется (планов в
  // разрезе групп/типов клиентов не существует) — процент честно показывает,
  // какую долю ПОЛНОГО плана дал выбранный срез.
  filters: CommonDealFilterOpts = {},
): Promise<Map<string, { sales: number; shipments: number }>> {
  const IDS = ['primary_sales_amount', 'repeat_sales_amount', 'primary_shipments_amount', 'repeat_shipments_amount'];
  const all = await loadMetrics();
  const metrics = all.filter(m => IDS.includes(m.id));
  const cw = buildCommonDealWhere(filters, 2);
  const sql = buildCollectedSQL(metrics, {
    idExpr: 'd.current_manager_id::text',
    groupBy: 'GROUP BY d.current_manager_id',
    notNullWhere: `d.current_manager_id IS NOT NULL${cw.sql ? ` AND ${cw.sql}` : ''}`,
  });
  const out = new Map<string, { sales: number; shipments: number }>();
  if (!sql) return out;

  const fromIso = fromZonedTime(`${fromDateStr} 00:00:00`, 'Europe/Moscow').toISOString();
  const toExclDate = new Date(`${toDateStr}T00:00:00Z`);
  toExclDate.setUTCDate(toExclDate.getUTCDate() + 1);
  const toExclIso = fromZonedTime(`${toExclDate.toISOString().slice(0, 10)} 00:00:00`, 'Europe/Moscow').toISOString();

  const res = await analyticsDb().query<Record<string, unknown> & { dimension_id: string }>(sql, [fromIso, toExclIso, ...cw.params]);
  const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  for (const row of res.rows) {
    out.set(row.dimension_id, {
      sales: num(row.primary_sales_amount) + num(row.repeat_sales_amount),
      shipments: num(row.primary_shipments_amount) + num(row.repeat_shipments_amount),
    });
  }
  return out;
}

export interface PlanEnrichOptions {
  /** Метрики отчёта с раскрытыми зависимостями — гейты «запрошена ли план-метрика». */
  withDeps: Metric[];
  /** Планы есть только у менеджеров: дорисовка строк и факты — только в этом разрезе. */
  isManagersReport: boolean;
  /** «Сегодня» (YYYY-MM-DD, МСК). Конструктор передаёт дату отчёта — план «на текущий
   *  день» и факты окон считаются на неё, а не на реальное сегодня. */
  mskTodayStr: string;
  current: { rows: ReportRow[]; fromStr: string; toStr: string };
  /** Период сравнения; нет — планы сравнения считаются по текущему периоду и не используются. */
  comparison?: { rows: ReportRow[]; fromStr: string; toStr: string };
  departmentIds?: string[];
  accountType: AccountType;
  commonDealFilters?: CommonDealFilterOpts;
}

export async function enrichPlanMetrics(o: PlanEnrichOptions): Promise<{ current: ReportRow[]; comparison: ReportRow[] }> {
  // Локальные имена — ровно те, что были в роуте: тело ниже перенесено без правок.
  const { withDeps, mskTodayStr, departmentIds, accountType } = o;
  const commonDealFilters: CommonDealFilterOpts = o.commonDealFilters ?? {};
  const reportSlug = o.isManagersReport ? 'by-managers' : 'other';
  let currentRows = o.current.rows;
  let compRows = o.comparison?.rows ?? [];
  const periodFromStr = o.current.fromStr;
  const periodToStr = o.current.toStr;
  const compPeriodFromStr = o.comparison?.fromStr ?? periodFromStr;
  const compPeriodToStr = o.comparison?.toStr ?? periodToStr;

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
    // «План (на тек. день)» = дневной × кол-во РАБОЧИХ ДНЕЙ ВЫБРАННОГО ПЕРИОДА
    // (обрезанного сегодняшним днём) ПО ПРОИЗВОДСТВЕННОМУ КАЛЕНДАРЮ
    // (working_calendar, getCalendarWorkingDaysInPeriod — не зависит от режима ÷20).
    // Переопределение 31.08, см. workdaysOf ниже; прежнее окно [начало месяца,
    // сегодня] игнорировало период отчёта.
    // DateRange для getCalendarWorkingDaysInPeriod: полночь/конец дня UTC — тогда
    // «полуденный» приём periodDateStrFromInstant внутри вернёт ровно эти даты.
    // null (календарь не заполнен на месяц) → «(на тек. день)» честно null.
    // Понедельник текущей недели (МСК) — для «(на текущий день недели)», миграция 147.
    const mskWeekStartStr = (() => {
      const d = new Date(`${mskTodayStr}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
    // «(на текущий день)» — ПЕРЕОПРЕДЕЛЕНИЕ 31.08 (жалоба владельца: «метрика
    // игнорирует выбранный период; по задумке — план на день × кол-во рабочих
    // дней в периоде»). Раньше окно было жёстко [начало ТЕКУЩЕГО месяца, сегодня]
    // (семантика 14.07) — при любом выбранном периоде значение не менялось.
    // Теперь: рабочие дни СВОЕГО периода у текущего и у периода сравнения,
    // будущее не считаем — окно обрезается сегодняшним днём (как и раньше);
    // период целиком в будущем → 0 рабочих дней → план 0.
    const clampToToday = (fromStr: string, toStr: string) => ({
      from: new Date(`${fromStr}T00:00:00.000Z`),
      to: new Date(`${(toStr < mskTodayStr ? toStr : mskTodayStr)}T23:59:59.999Z`),
    });
    const workdaysOf = (fromStr: string, toStr: string): Promise<number | null> =>
      fromStr > mskTodayStr ? Promise.resolve(0) : getCalendarWorkingDaysInPeriod(clampToToday(fromStr, toStr));
    const [planByLoginCurrent, planByLoginComp, workdayNumCurrent, workdayNumComp, weekWorkdayNum] = await Promise.all([
      loadPlanByLogin(periodFromStr, periodToStr),
      loadPlanByLogin(compPeriodFromStr, compPeriodToStr),
      workdaysOf(periodFromStr, periodToStr),
      workdaysOf(compPeriodFromStr, compPeriodToStr),
      getCalendarWorkingDaysInPeriod({
        from: new Date(`${mskWeekStartStr}T00:00:00.000Z`),
        to: new Date(`${mskTodayStr}T23:59:59.999Z`),
      }),
    ]);

    const enrichRow = (
      row: ReportRow,
      planByLogin: Map<string, { plan_shipments: number; plan_n: number }>,
      workdayNum: number | null,
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

    currentRows = currentRows.map(r => enrichRow(r, planByLoginCurrent, workdayNumCurrent));
    compRows = compRows.map(r => enrichRow(r, planByLoginComp, workdayNumComp));
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
      fetchPlanFactWindow(mskTodayStr, mskTodayStr, commonDealFilters),
      fetchPlanFactWindow(monthStartStr, mskTodayStr, commonDealFilters),
      fetchPlanFactWindow(weekStartStr, mskTodayStr, commonDealFilters),
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

  return { current: currentRows, comparison: compRows };
}
