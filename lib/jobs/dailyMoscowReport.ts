// Ежедневный отчёт «МОСКВА» для бота «Аналитик» (личка владельца, 18:00 МСК).
//
// Источники (решение владельца, 2026-07-07):
//  - Суммы продаж/отгрузок — ЖИВЬЁМ из Битрикса (mlt.sales.list / mlt.shipments.list):
//    к 18:00 наша БД может отставать, Битрикс — истина.
//  - Те же суммы параллельно считаются из нашей БД → блок «Расхождения» в конце
//    отчёта (контроль точности синка).
//  - Конверсии за месяц — из БД (методов Битрикса со списком броней за период нет).
//  - Планы: manager_plans (план отгрузок менеджера = plan_shipments, план продаж =
//    plan_shipments / plan_n — та же логика, что в app/api/reports/run). Дневной план =
//    месячный / рабочие дни месяца; недельный = дневной × рабочие дни недели;
//    план на дату (MTD) = дневной × прошедшие рабочие дни.

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { getManagerOrgMap } from '@/lib/org/deptCategories';
import { bx, sendBitrixBotMessage } from '@/lib/bitrix/notify';
import { getMonthWorkingDays, getWeekWorkingDaysTotal } from '@/lib/plans/dailyPlan';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

const TZ = 'Europe/Moscow';
const BRANCH = 'МСК';
const DEPTS = ['ОС', 'НЦ', 'ЖБИ'] as const;
type Dept = (typeof DEPTS)[number];
const DEPT_TITLES: Record<Dept, string> = { 'ОС': 'Общестрой', 'НЦ': 'Нулевой', 'ЖБИ': 'ЖБИ' };

// Суммы по отделам + итого; ключи — категории отделов МСК.
type DeptSums = Record<Dept | 'total', number>;
const zeroSums = (): DeptSums => ({ 'ОС': 0, 'НЦ': 0, 'ЖБИ': 0, total: 0 });

interface PeriodSums { day: DeptSums; week: DeptSums; month: DeptSums }

interface ConversionRow {
  deals: number; reservations: number; sales: number;
  primarySales: number; repeatSales: number; ppp: number;
}
type Conversions = Record<Dept | 'total', ConversionRow>;

export interface DailyReportData {
  dateStr: string; // YYYY-MM-DD (отчётная дата, МСК)
  message: string;            // основной отчёт (без расхождений)
  discrepancyMessage: string; // сверка Битрикс ↔ БД — отдельным сообщением
  discrepancies: string[];
}

// ── Даты (всё в стенных часах МСК) ─────────────────────────────────────────────────

function moscowTodayStr(): string {
  const now = toZonedTime(new Date(), TZ);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Понедельник недели, в которую входит dateStr. */
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7; // Пн=0 … Вс=6
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** UTC-инстант московской полуночи данной даты (для timestamptz-границ в БД). */
function mskMidnightIso(dateStr: string): string {
  return fromZonedTime(`${dateStr} 00:00:00`, TZ).toISOString();
}

function fmtDateRu(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

// ── Форматирование ─────────────────────────────────────────────────────────────────

function fmtMln(v: number, decimals = 1): string {
  return `${(v / 1e6).toFixed(decimals).replace('.', ',')} млн`;
}

function fmtPctInt(fact: number, plan: number): string {
  if (plan <= 0) return '—';
  return `${Math.round((fact / plan) * 100)}%`;
}

function fmtPct1(numerator: number, denominator: number): string {
  if (denominator <= 0) return '—';
  return `${((numerator / denominator) * 100).toFixed(1).replace('.', ',')}%`;
}

// ── Битрикс: продажи/отгрузки за период ────────────────────────────────────────────

interface BitrixDeal { ASSIGNED_BY_ID: string; OPPORTUNITY: string; [k: string]: unknown }

async function fetchBitrixDeals(method: string, dateFrom: string, dateTo: string): Promise<BitrixDeal[]> {
  const webhook = process.env.BITRIX_WEBHOOK_URL || '';
  const out: BitrixDeal[] = [];
  let start: number | undefined;
  // mlt.* методы обычно отдают всё одним ответом, но на случай стандартной
  // битриксовой пагинации крутимся по body.next.
  for (let guard = 0; guard < 100; guard++) {
    const body = await bx(webhook, method, { DATE_FROM: dateFrom, DATE_TO: dateTo, ...(start !== undefined ? { start } : {}) });
    const items = (body?.result ?? []) as BitrixDeal[];
    out.push(...items);
    if (body?.next === undefined || body?.next === null || items.length === 0) break;
    start = Number(body.next);
  }
  return out;
}

/** Суммирует сделки Битрикса по отделам МСК в окна день/неделя/месяц. */
function sumBitrixByPeriods(
  deals: BitrixDeal[],
  dateField: string,
  orgMap: Map<string, { branch: string; category: string | null }>,
  reportDate: string,
  weekStart: string,
): PeriodSums {
  const sums: PeriodSums = { day: zeroSums(), week: zeroSums(), month: zeroSums() };
  for (const deal of deals) {
    const org = orgMap.get(String(deal.ASSIGNED_BY_ID));
    if (!org || org.branch !== BRANCH) continue;
    const cat = org.category as Dept | null;
    if (!cat || !DEPTS.includes(cat)) continue;

    const raw = String(deal[dateField] ?? '');
    const dateStr = raw.slice(0, 10); // 'YYYY-MM-DD HH:mm:ss' в часовом поясе портала (МСК)
    if (!dateStr || dateStr > reportDate) continue;

    const amount = parseFloat(String(deal.OPPORTUNITY)) || 0;
    sums.month[cat] += amount;
    sums.month.total += amount;
    if (dateStr >= weekStart) { sums.week[cat] += amount; sums.week.total += amount; }
    if (dateStr === reportDate) { sums.day[cat] += amount; sums.day.total += amount; }
  }
  return sums;
}

// ── БД: те же суммы + конверсии ────────────────────────────────────────────────────

async function queryDbByManager(metricIds: string[], fromIso: string, toExclIso: string): Promise<Map<string, Record<string, number>>> {
  const all = await loadMetrics();
  const metrics = all.filter(m => metricIds.includes(m.id));
  const sql = buildCollectedSQL(metrics, {
    idExpr: 'd.current_manager_id::text',
    groupBy: 'GROUP BY d.current_manager_id',
    notNullWhere: 'd.current_manager_id IS NOT NULL',
  });
  const out = new Map<string, Record<string, number>>();
  if (!sql) return out;
  const res = await analyticsDb().query<Record<string, unknown> & { dimension_id: string }>(sql, [fromIso, toExclIso]);
  for (const row of res.rows) {
    const vals: Record<string, number> = {};
    for (const id of metricIds) {
      const v = row[id];
      vals[id] = v !== null && v !== undefined ? Number(v) : 0;
    }
    out.set(row.dimension_id, vals);
  }
  return out;
}

function sumDbToDepts(
  byManager: Map<string, Record<string, number>>,
  metricIds: string[],
  orgMap: Map<string, { branch: string; category: string | null }>,
): DeptSums {
  const sums = zeroSums();
  for (const [managerId, vals] of byManager) {
    const org = orgMap.get(managerId);
    if (!org || org.branch !== BRANCH) continue;
    const cat = org.category as Dept | null;
    if (!cat || !DEPTS.includes(cat)) continue;
    const amount = metricIds.reduce((acc, id) => acc + (vals[id] ?? 0), 0);
    sums[cat] += amount;
    sums.total += amount;
  }
  return sums;
}

const SALES_AMOUNT_IDS = ['primary_sales_amount', 'repeat_sales_amount'];
const SHIPMENT_AMOUNT_IDS = ['primary_shipments_amount', 'repeat_shipments_amount'];
const CONVERSION_IDS = ['deals_count', 'reservations_count', 'sales_count', 'primary_sales_count', 'repeat_sales_count', 'ppp_count'];

async function getDbConversions(
  fromIso: string,
  toExclIso: string,
  orgMap: Map<string, { branch: string; category: string | null }>,
): Promise<Conversions> {
  const byManager = await queryDbByManager(CONVERSION_IDS, fromIso, toExclIso);
  const zero = (): ConversionRow => ({ deals: 0, reservations: 0, sales: 0, primarySales: 0, repeatSales: 0, ppp: 0 });
  const conv: Conversions = { 'ОС': zero(), 'НЦ': zero(), 'ЖБИ': zero(), total: zero() };
  for (const [managerId, vals] of byManager) {
    const org = orgMap.get(managerId);
    if (!org || org.branch !== BRANCH) continue;
    const cat = org.category as Dept | null;
    if (!cat || !DEPTS.includes(cat)) continue;
    for (const target of [conv[cat], conv.total]) {
      target.deals += vals.deals_count ?? 0;
      target.reservations += vals.reservations_count ?? 0;
      target.sales += vals.sales_count ?? 0;
      target.primarySales += vals.primary_sales_count ?? 0;
      target.repeatSales += vals.repeat_sales_count ?? 0;
      target.ppp += vals.ppp_count ?? 0;
    }
  }
  return conv;
}

// ── Планы ──────────────────────────────────────────────────────────────────────────

interface DeptPlans { sales: DeptSums; shipments: DeptSums }

async function getMonthPlans(
  monthFirstDay: string,
  orgMap: Map<string, { branch: string; category: string | null }>,
): Promise<DeptPlans> {
  // manager_plans.manager_login — это short_login ('#8' из bitrix_login 'manager8'),
  // НЕ bitrix user id; связь с менеджером только через org_resolved_hierarchy.
  // Оргструктура переехала в sa (задача Серёги 13.07), а manager_plans осталась в
  // system → кросс-БД JOIN невозможен: тянем обе стороны отдельными пулами и
  // джойним в коде по short_login (семантика INNER JOIN — строки без совпадения
  // отбрасываются, как и раньше).
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

  const plans: DeptPlans = { sales: zeroSums(), shipments: zeroSums() };
  for (const row of plansRes.rows) {
    const managerId = managerIdByShortLogin.get(row.manager_login);
    if (!managerId) continue; // нет активного менеджера с таким short_login — как INNER JOIN
    const org = orgMap.get(managerId);
    if (!org || org.branch !== BRANCH) continue;
    const cat = org.category as Dept | null;
    if (!cat || !DEPTS.includes(cat)) continue;
    const ship = parseFloat(row.plan_shipments) || 0;
    const n = parseFloat(row.plan_n);
    const sales = n > 0 ? ship / n : ship;
    plans.shipments[cat] += ship;
    plans.shipments.total += ship;
    plans.sales[cat] += sales;
    plans.sales.total += sales;
  }
  return plans;
}

interface WorkingDays { inMonth: number; passedInMonth: number; inWeek: number }

// Источник — общий хелпер lib/plans/dailyPlan (п.7 спеки): дефолт "месячный план ÷ 20"
// (inMonth=20, недельная константа inWeek=5), либо working_calendar, если супер-админ
// включил режим "производственный календарь".
async function getWorkingDays(monthFirstDay: string, reportDate: string, weekStart: string): Promise<WorkingDays> {
  const [month, inWeek] = await Promise.all([
    getMonthWorkingDays(monthFirstDay, reportDate),
    getWeekWorkingDaysTotal(weekStart),
  ]);
  return { inMonth: month.total, passedInMonth: month.passed, inWeek };
}

// ── Расхождения Битрикс ↔ БД ───────────────────────────────────────────────────────

const DISCREPANCY_THRESHOLD = 50_000; // ₽; суммы в отчёте округляются до 0,1 млн

function collectDiscrepancies(
  label: string,
  bitrix: PeriodSums,
  db: PeriodSums,
): string[] {
  const out: string[] = [];
  const periods: [keyof PeriodSums, string][] = [['day', 'день'], ['week', 'неделя'], ['month', 'месяц']];
  for (const [key, periodName] of periods) {
    const parts: string[] = [];
    for (const cat of [...DEPTS, 'total'] as const) {
      const b = bitrix[key][cat];
      const d = db[key][cat];
      if (Math.abs(b - d) >= DISCREPANCY_THRESHOLD) {
        const name = cat === 'total' ? 'ИТОГО' : DEPT_TITLES[cat];
        parts.push(`${name} ${fmtMln(b, 2)} → ${fmtMln(d, 2)}`);
      }
    }
    if (parts.length > 0) out.push(`${label} (${periodName}): ${parts.join('; ')}`);
  }
  return out;
}

// ── Сборка отчёта ──────────────────────────────────────────────────────────────────

function planPercentSection(title: string, fact: DeptSums, plan: DeptSums): string {
  const lines = [`[b]% ПЛАНА (${title}) — ${fmtPctInt(fact.total, plan.total)}[/b]`];
  for (const cat of DEPTS) lines.push(`${DEPT_TITLES[cat]} — ${fmtPctInt(fact[cat], plan[cat])}`);
  return lines.join('\n');
}

function conversionSection(title: string, conv: Conversions, num: (r: ConversionRow) => number, den: (r: ConversionRow) => number): string {
  const lines = [`[b]${title} — ${fmtPct1(num(conv.total), den(conv.total))}[/b]`];
  for (const cat of DEPTS) lines.push(`${DEPT_TITLES[cat]} — ${fmtPct1(num(conv[cat]), den(conv[cat]))}`);
  return lines.join('\n');
}

function deptBlock(title: string, planSales: number, factSales: number, planShip: number, factShip: number): string {
  return [
    `[b]${title}[/b]`,
    `План продаж — ${fmtMln(planSales)}`,
    `Сумма продаж — ${fmtMln(factSales)}`,
    `% выполнения — ${fmtPctInt(factSales, planSales)}`,
    '',
    `План отгрузок — ${fmtMln(planShip)}`,
    `Сумма отгрузок — ${fmtMln(factShip)}`,
    `% выполнения — ${fmtPctInt(factShip, planShip)}`,
  ].join('\n');
}

/**
 * Строит отчёт за указанную дату (по умолчанию — сегодня по МСК).
 * reportDate в прошлом даёт ретро-отчёт: окна день/неделя/месяц заканчиваются этой датой.
 */
export async function buildDailyMoscowReport(reportDate?: string): Promise<DailyReportData> {
  const dateStr = reportDate ?? moscowTodayStr();
  const monthFirstDay = `${dateStr.slice(0, 7)}-01`;
  const weekStart = mondayOf(dateStr);
  // Неделя может начаться в прошлом месяце — тогда её факт всё равно нужен целиком.
  const factFrom = weekStart < monthFirstDay ? weekStart : monthFirstDay;
  const nextDay = addDaysStr(dateStr, 1);

  const orgMap = await getManagerOrgMap();

  const [bitrixSales, bitrixShipments, wd, plans, dbConv] = await Promise.all([
    fetchBitrixDeals('mlt.sales.list', factFrom, dateStr),
    fetchBitrixDeals('mlt.shipments.list', factFrom, dateStr),
    getWorkingDays(monthFirstDay, dateStr, weekStart),
    getMonthPlans(monthFirstDay, orgMap),
    getDbConversions(mskMidnightIso(monthFirstDay), mskMidnightIso(nextDay), orgMap),
  ]);

  const bxSales = sumBitrixByPeriods(bitrixSales, 'MLT_DATE_SALE', orgMap, dateStr, weekStart);
  const bxShip = sumBitrixByPeriods(bitrixShipments, 'MLT_DATE_SHIPMENT', orgMap, dateStr, weekStart);

  // БД-суммы для блока расхождений: SQL-генератор принимает одно окно на запрос,
  // поэтому день/неделя/месяц считаются отдельными запросами.
  const [dbSalesDay, dbShipDay, dbSalesWeek, dbShipWeek, dbSalesMonth, dbShipMonth] = await Promise.all([
    queryDbByManager(SALES_AMOUNT_IDS, mskMidnightIso(dateStr), mskMidnightIso(nextDay)),
    queryDbByManager(SHIPMENT_AMOUNT_IDS, mskMidnightIso(dateStr), mskMidnightIso(nextDay)),
    queryDbByManager(SALES_AMOUNT_IDS, mskMidnightIso(weekStart), mskMidnightIso(nextDay)),
    queryDbByManager(SHIPMENT_AMOUNT_IDS, mskMidnightIso(weekStart), mskMidnightIso(nextDay)),
    queryDbByManager(SALES_AMOUNT_IDS, mskMidnightIso(monthFirstDay), mskMidnightIso(nextDay)),
    queryDbByManager(SHIPMENT_AMOUNT_IDS, mskMidnightIso(monthFirstDay), mskMidnightIso(nextDay)),
  ]);

  const dbSalesSums: PeriodSums = {
    day: sumDbToDepts(dbSalesDay, SALES_AMOUNT_IDS, orgMap),
    week: sumDbToDepts(dbSalesWeek, SALES_AMOUNT_IDS, orgMap),
    month: sumDbToDepts(dbSalesMonth, SALES_AMOUNT_IDS, orgMap),
  };
  const dbShipSums: PeriodSums = {
    day: sumDbToDepts(dbShipDay, SHIPMENT_AMOUNT_IDS, orgMap),
    week: sumDbToDepts(dbShipWeek, SHIPMENT_AMOUNT_IDS, orgMap),
    month: sumDbToDepts(dbShipMonth, SHIPMENT_AMOUNT_IDS, orgMap),
  };

  // Плановые окна (продажи; % ПЛАНА в шапке отчёта считается по продажам).
  const scale = (sums: DeptSums, k: number): DeptSums => {
    const out = zeroSums();
    for (const cat of [...DEPTS, 'total'] as const) out[cat] = sums[cat] * k;
    return out;
  };
  const dayPlanSales = scale(plans.sales, 1 / wd.inMonth);
  const weekPlanSales = scale(dayPlanSales, wd.inWeek);
  const mtdPlanSales = scale(dayPlanSales, wd.passedInMonth);
  const mtdPlanShip = scale(plans.shipments, wd.passedInMonth / wd.inMonth);

  const discrepancies = [
    ...collectDiscrepancies('Продажи', bxSales, dbSalesSums),
    ...collectDiscrepancies('Отгрузки', bxShip, dbShipSums),
  ];

  // Вёрстка по эталону владельца: шапка и блоки «% ПЛАНА» без разделителя между собой;
  // «————» на отдельной строке, ВПЛОТНУЮ к следующей секции (пустая строка только сверху).
  const message = [
    [
      `[b]Отчет МОСКВА[/b]\n[i]за ${fmtDateRu(dateStr)}[/i]`,
      planPercentSection('ДЕНЬ', bxSales.day, dayPlanSales),
      planPercentSection('НЕДЕЛЯ', bxSales.week, weekPlanSales),
      planPercentSection('МЕСЯЦ', bxSales.month, mtdPlanSales),
    ].join('\n\n'),
    [
      conversionSection('Конверсия в бронь (месяц)', dbConv, r => r.reservations, r => r.deals),
      conversionSection('Конверсия в продажу (месяц)', dbConv, r => r.sales, r => r.deals),
      conversionSection('Конверсия ППП (месяц)', dbConv, r => r.ppp, r => r.primarySales),
      conversionSection('% повторных продаж (месяц)', dbConv, r => r.repeatSales, r => r.primarySales + r.repeatSales),
    ].join('\n\n'),
    DEPTS.map(cat => deptBlock(
      DEPT_TITLES[cat].toUpperCase(),
      mtdPlanSales[cat], bxSales.month[cat],
      mtdPlanShip[cat], bxShip.month[cat],
    )).join('\n\n'),
    deptBlock(
      'ИТОГО (ОС+НЦ+ЖБИ)',
      mtdPlanSales.total, bxSales.month.total,
      mtdPlanShip.total, bxShip.month.total,
    ),
  ].join('\n\n————\n');

  const discrepancyMessage = `[b]Сверка Битрикс ↔ БД за ${fmtDateRu(dateStr)}[/b]\n` + (
    discrepancies.length > 0
      ? discrepancies.join('\n')
      : `Расхождений нет (порог ${DISCREPANCY_THRESHOLD / 1000} тыс ₽)`
  );

  return { dateStr, message, discrepancyMessage, discrepancies };
}

/** Отправляет отчёт получателю из DAILY_REPORT_BITRIX_USER_ID (или явно указанному).
 *  Два сообщения: сам отчёт и отдельно сверка расхождений (просьба владельца). */
export async function sendDailyMoscowReport(dialogId?: string, reportDate?: string): Promise<DailyReportData> {
  const recipient = dialogId || process.env.DAILY_REPORT_BITRIX_USER_ID || '';
  if (!recipient) throw new Error('DAILY_REPORT_BITRIX_USER_ID не задан — некому отправлять ежедневный отчёт');
  const report = await buildDailyMoscowReport(reportDate);
  await sendBitrixBotMessage(recipient, report.message);
  await sendBitrixBotMessage(recipient, report.discrepancyMessage);
  return report;
}
