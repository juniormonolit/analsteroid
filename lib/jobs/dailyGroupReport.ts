// Обобщённый движок ежедневных отчётов «план/факт + конверсии» (задача владельца
// 03.08: «пришли такой же отчёт пользователю 1923, но с разбивкой по командам
// Общестроя»).
//
// Вся математика — ровно та же, что в lib/jobs/dailyMoscowReport.ts (тот отчёт
// остаётся источником правды формата): суммы продаж/отгрузок берутся ЖИВЬЁМ из
// Битрикса (mlt.sales.list / mlt.shipments.list — к 18:00 наша БД может отставать),
// планы — из manager_plans через short_login (план продаж = plan_shipments / plan_n),
// дневной план = месячный ÷ рабочие дни, окна недели/месяца — ТЕМП (план на
// прошедшие рабочие дни), конверсии за месяц — из БД по ПЕРВИЧНЫМ метрикам, плюс
// блок расхождений Битрикс ↔ БД.
//
// Единственное, что параметризовано — ГРУППИРОВКА: вместо жёстких категорий
// МСК (ОС/НЦ/ЖБИ) на вход подаётся список групп с готовыми наборами bitrix-id
// менеджеров. Так один движок обслуживает и «Москву по департаментам», и
// «Общестрой по командам», и любую будущую нарезку.

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { bx, sendBitrixBotMessage } from '@/lib/bitrix/notify';
import { getMonthWorkingDays, getWeekWorkingDays } from '@/lib/plans/dailyPlan';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

const TZ = 'Europe/Moscow';
const TOTAL_KEY = '__total__';

export interface ReportGroup {
  /** Стабильный ключ группы (для сумм). */
  key: string;
  /** Подпись в отчёте — как владелец называет группу («Осипов», «Общестрой»). */
  title: string;
  /** bitrix user id менеджеров группы. */
  managerIds: Set<string>;
}

export interface GroupReportConfig {
  /** Заголовок: «Отчет КОВАЛЕНКО» / «Отчет МОСКВА». */
  header: string;
  /** Подпись итогового блока: «ОБЩЕСТРОЙ» / «ИТОГО (ОС+НЦ+ЖБИ)». */
  totalTitle: string;
  groups: ReportGroup[];
  /** Итоговые суммы в рублях (как в ручном отчёте Коваленко) вместо «млн». */
  totalsInRubles?: boolean;
}

type Sums = Record<string, number>; // ключ группы | TOTAL_KEY
interface PeriodSums { day: Sums; week: Sums; month: Sums }

interface ConversionRow {
  primaryDeals: number; primaryReservations: number;
  primarySales: number; repeatSales: number; ppp: number;
}

export interface GroupReportData {
  dateStr: string;
  message: string;
  discrepancyMessage: string;
  discrepancies: string[];
}

// ── Даты (стенные часы МСК) ────────────────────────────────────────────────────────

function moscowTodayStr(): string {
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
function fmtDateRu(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}
const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
function weekdayRu(dateStr: string): string {
  return WEEKDAYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}

// ── Форматирование ─────────────────────────────────────────────────────────────────

function fmtMln(v: number, decimals = 1): string {
  return `${(v / 1e6).toFixed(decimals).replace('.', ',')} млн`;
}
function fmtRub(v: number): string {
  return `${Math.round(v).toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`;
}
/** % выполнения плана — 1 знак после запятой (как в ручном отчёте Коваленко). */
function fmtPct1OfPlan(fact: number, plan: number): string {
  if (plan <= 0) return '—';
  return `${((fact / plan) * 100).toFixed(1).replace('.', ',')}%`;
}
function fmtPct1(numerator: number, denominator: number): string {
  if (denominator <= 0) return '—';
  return `${((numerator / denominator) * 100).toFixed(1).replace('.', ',')}%`;
}

// ── Битрикс ────────────────────────────────────────────────────────────────────────

interface BitrixDeal { ASSIGNED_BY_ID: string; OPPORTUNITY: string; [k: string]: unknown }

async function fetchBitrixDeals(method: string, dateFrom: string, dateTo: string): Promise<BitrixDeal[]> {
  const webhook = process.env.BITRIX_WEBHOOK_URL || '';
  const out: BitrixDeal[] = [];
  let start: number | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const body = await bx(webhook, method, { DATE_FROM: dateFrom, DATE_TO: dateTo, ...(start !== undefined ? { start } : {}) });
    const items = (body?.result ?? []) as BitrixDeal[];
    out.push(...items);
    if (body?.next === undefined || body?.next === null || items.length === 0) break;
    start = Number(body.next);
  }
  return out;
}

// ── Помощники группировки ──────────────────────────────────────────────────────────

function zeroSums(groups: ReportGroup[]): Sums {
  const s: Sums = { [TOTAL_KEY]: 0 };
  for (const g of groups) s[g.key] = 0;
  return s;
}

/** managerId → ключ группы. Менеджер вне групп в отчёт не попадает. */
function buildGroupIndex(groups: ReportGroup[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const g of groups) for (const id of g.managerIds) idx.set(id, g.key);
  return idx;
}

function sumBitrixByPeriods(
  deals: BitrixDeal[],
  dateField: string,
  groupIndex: Map<string, string>,
  groups: ReportGroup[],
  reportDate: string,
  weekStart: string,
): PeriodSums {
  const sums: PeriodSums = { day: zeroSums(groups), week: zeroSums(groups), month: zeroSums(groups) };
  for (const deal of deals) {
    const key = groupIndex.get(String(deal.ASSIGNED_BY_ID));
    if (!key) continue;
    const dateStr = String(deal[dateField] ?? '').slice(0, 10); // портал отдаёт время МСК
    if (!dateStr || dateStr > reportDate) continue;
    const amount = parseFloat(String(deal.OPPORTUNITY)) || 0;
    sums.month[key] += amount; sums.month[TOTAL_KEY] += amount;
    if (dateStr >= weekStart) { sums.week[key] += amount; sums.week[TOTAL_KEY] += amount; }
    if (dateStr === reportDate) { sums.day[key] += amount; sums.day[TOTAL_KEY] += amount; }
  }
  return sums;
}

// ── БД ─────────────────────────────────────────────────────────────────────────────

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

function sumDbToGroups(
  byManager: Map<string, Record<string, number>>,
  metricIds: string[],
  groupIndex: Map<string, string>,
  groups: ReportGroup[],
): Sums {
  const sums = zeroSums(groups);
  for (const [managerId, vals] of byManager) {
    const key = groupIndex.get(managerId);
    if (!key) continue;
    const amount = metricIds.reduce((acc, id) => acc + (vals[id] ?? 0), 0);
    sums[key] += amount;
    sums[TOTAL_KEY] += amount;
  }
  return sums;
}

const SALES_AMOUNT_IDS = ['primary_sales_amount', 'repeat_sales_amount'];
const SHIPMENT_AMOUNT_IDS = ['primary_shipments_amount', 'repeat_shipments_amount'];
const CONVERSION_IDS = ['primary_deals_count', 'primary_reservations_count', 'primary_sales_count', 'repeat_sales_count', 'ppp_count'];

async function getDbConversions(
  fromIso: string, toExclIso: string,
  groupIndex: Map<string, string>, groups: ReportGroup[],
): Promise<Record<string, ConversionRow>> {
  const byManager = await queryDbByManager(CONVERSION_IDS, fromIso, toExclIso);
  const zero = (): ConversionRow => ({ primaryDeals: 0, primaryReservations: 0, primarySales: 0, repeatSales: 0, ppp: 0 });
  const conv: Record<string, ConversionRow> = { [TOTAL_KEY]: zero() };
  for (const g of groups) conv[g.key] = zero();
  for (const [managerId, vals] of byManager) {
    const key = groupIndex.get(managerId);
    if (!key) continue;
    for (const target of [conv[key], conv[TOTAL_KEY]]) {
      target.primaryDeals += vals.primary_deals_count ?? 0;
      target.primaryReservations += vals.primary_reservations_count ?? 0;
      target.primarySales += vals.primary_sales_count ?? 0;
      target.repeatSales += vals.repeat_sales_count ?? 0;
      target.ppp += vals.ppp_count ?? 0;
    }
  }
  return conv;
}

// ── Планы ──────────────────────────────────────────────────────────────────────────

interface GroupPlans { sales: Sums; shipments: Sums }

async function getMonthPlans(
  monthFirstDay: string, groupIndex: Map<string, string>, groups: ReportGroup[],
): Promise<GroupPlans> {
  // manager_plans.manager_login — short_login ('#8'), НЕ bitrix id; связь только
  // через sa.org_resolved_hierarchy. Кросс-БД (planы в system, оргструктура в sa) —
  // джойн в коде.
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

  const plans: GroupPlans = { sales: zeroSums(groups), shipments: zeroSums(groups) };
  for (const row of plansRes.rows) {
    const managerId = managerIdByShortLogin.get(row.manager_login);
    if (!managerId) continue;
    const key = groupIndex.get(managerId);
    if (!key) continue;
    const ship = parseFloat(row.plan_shipments) || 0;
    const n = parseFloat(row.plan_n);
    const sales = n > 0 ? ship / n : ship;
    plans.shipments[key] += ship; plans.shipments[TOTAL_KEY] += ship;
    plans.sales[key] += sales;    plans.sales[TOTAL_KEY] += sales;
  }
  return plans;
}

interface WorkingDays { inMonth: number; passedInMonth: number; passedInWeek: number }

async function getWorkingDays(monthFirstDay: string, reportDate: string, weekStart: string): Promise<WorkingDays> {
  const [month, week] = await Promise.all([
    getMonthWorkingDays(monthFirstDay, reportDate),
    getWeekWorkingDays(weekStart, reportDate),
  ]);
  return { inMonth: month.total, passedInMonth: month.passed, passedInWeek: week.passed };
}

// ── Расхождения Битрикс ↔ БД ───────────────────────────────────────────────────────

const DISCREPANCY_THRESHOLD = 50_000;

function collectDiscrepancies(label: string, bitrix: PeriodSums, db: PeriodSums, groups: ReportGroup[]): string[] {
  const out: string[] = [];
  const periods: [keyof PeriodSums, string][] = [['day', 'день'], ['week', 'неделя'], ['month', 'месяц']];
  const titleByKey = new Map(groups.map(g => [g.key, g.title]));
  for (const [key, periodName] of periods) {
    const parts: string[] = [];
    for (const k of [...groups.map(g => g.key), TOTAL_KEY]) {
      const b = bitrix[key][k] ?? 0;
      const d = db[key][k] ?? 0;
      if (Math.abs(b - d) >= DISCREPANCY_THRESHOLD) {
        parts.push(`${k === TOTAL_KEY ? 'ИТОГО' : titleByKey.get(k)} ${fmtMln(b, 2)} → ${fmtMln(d, 2)}`);
      }
    }
    if (parts.length > 0) out.push(`${label} (${periodName}): ${parts.join('; ')}`);
  }
  return out;
}

// ── Сборка ─────────────────────────────────────────────────────────────────────────

function planPercentSection(title: string, fact: Sums, plan: Sums, groups: ReportGroup[]): string {
  const lines = [`[b]% ПЛАНА (${title}) — ${fmtPct1OfPlan(fact[TOTAL_KEY], plan[TOTAL_KEY])}[/b]`];
  for (const g of groups) lines.push(`${g.title} — ${fmtPct1OfPlan(fact[g.key], plan[g.key])}`);
  return lines.join('\n');
}

function conversionSection(
  title: string, conv: Record<string, ConversionRow>, groups: ReportGroup[],
  num: (r: ConversionRow) => number, den: (r: ConversionRow) => number,
): string {
  const lines = [`[b]${title} — ${fmtPct1(num(conv[TOTAL_KEY]), den(conv[TOTAL_KEY]))}[/b]`];
  for (const g of groups) lines.push(`${g.title} — ${fmtPct1(num(conv[g.key]), den(conv[g.key]))}`);
  return lines.join('\n');
}

function totalsBlock(
  title: string, planSales: number, factSales: number, planShip: number, factShip: number, inRubles: boolean,
): string {
  const money = (v: number) => (inRubles ? fmtRub(v) : fmtMln(v));
  return [
    `[b]${title}[/b]`,
    `План продаж — ${money(planSales)}`,
    `Сумма продаж — ${money(factSales)}`,
    `% выполнения — ${fmtPct1OfPlan(factSales, planSales)}`,
    '',
    `План отгрузок — ${money(planShip)}`,
    `Сумма отгрузок — ${money(factShip)}`,
    `% выполнения — ${fmtPct1OfPlan(factShip, planShip)}`,
  ].join('\n');
}

export async function buildGroupReport(config: GroupReportConfig, reportDate?: string): Promise<GroupReportData> {
  const { groups } = config;
  const dateStr = reportDate ?? moscowTodayStr();
  const monthFirstDay = `${dateStr.slice(0, 7)}-01`;
  const weekStart = mondayOf(dateStr);
  const factFrom = weekStart < monthFirstDay ? weekStart : monthFirstDay;
  const nextDay = addDaysStr(dateStr, 1);
  const groupIndex = buildGroupIndex(groups);

  const [bitrixSales, bitrixShipments, wd, plans, dbConv] = await Promise.all([
    fetchBitrixDeals('mlt.sales.list', factFrom, dateStr),
    fetchBitrixDeals('mlt.shipments.list', factFrom, dateStr),
    getWorkingDays(monthFirstDay, dateStr, weekStart),
    getMonthPlans(monthFirstDay, groupIndex, groups),
    getDbConversions(mskMidnightIso(monthFirstDay), mskMidnightIso(nextDay), groupIndex, groups),
  ]);

  const bxSales = sumBitrixByPeriods(bitrixSales, 'MLT_DATE_SALE', groupIndex, groups, dateStr, weekStart);
  const bxShip = sumBitrixByPeriods(bitrixShipments, 'MLT_DATE_SHIPMENT', groupIndex, groups, dateStr, weekStart);

  // БД-суммы для блока расхождений (по одному окну на запрос — так устроен sqlGen)
  const [dbSalesDay, dbShipDay, dbSalesWeek, dbShipWeek, dbSalesMonth, dbShipMonth] = await Promise.all([
    queryDbByManager(SALES_AMOUNT_IDS, mskMidnightIso(dateStr), mskMidnightIso(nextDay)),
    queryDbByManager(SHIPMENT_AMOUNT_IDS, mskMidnightIso(dateStr), mskMidnightIso(nextDay)),
    queryDbByManager(SALES_AMOUNT_IDS, mskMidnightIso(weekStart), mskMidnightIso(nextDay)),
    queryDbByManager(SHIPMENT_AMOUNT_IDS, mskMidnightIso(weekStart), mskMidnightIso(nextDay)),
    queryDbByManager(SALES_AMOUNT_IDS, mskMidnightIso(monthFirstDay), mskMidnightIso(nextDay)),
    queryDbByManager(SHIPMENT_AMOUNT_IDS, mskMidnightIso(monthFirstDay), mskMidnightIso(nextDay)),
  ]);
  const dbSalesSums: PeriodSums = {
    day: sumDbToGroups(dbSalesDay, SALES_AMOUNT_IDS, groupIndex, groups),
    week: sumDbToGroups(dbSalesWeek, SALES_AMOUNT_IDS, groupIndex, groups),
    month: sumDbToGroups(dbSalesMonth, SALES_AMOUNT_IDS, groupIndex, groups),
  };
  const dbShipSums: PeriodSums = {
    day: sumDbToGroups(dbShipDay, SHIPMENT_AMOUNT_IDS, groupIndex, groups),
    week: sumDbToGroups(dbShipWeek, SHIPMENT_AMOUNT_IDS, groupIndex, groups),
    month: sumDbToGroups(dbShipMonth, SHIPMENT_AMOUNT_IDS, groupIndex, groups),
  };

  // Плановые окна: дневной план = месячный ÷ рабочие дни месяца; неделя/месяц — темп
  const scale = (sums: Sums, k: number): Sums => {
    const out: Sums = {};
    for (const key of Object.keys(sums)) out[key] = sums[key] * k;
    return out;
  };
  const dayPlanSales = scale(plans.sales, 1 / wd.inMonth);
  const weekPlanSales = scale(dayPlanSales, wd.passedInWeek);
  const mtdPlanSales = scale(dayPlanSales, wd.passedInMonth);
  const mtdPlanShip = scale(plans.shipments, wd.passedInMonth / wd.inMonth);

  const discrepancies = [
    ...collectDiscrepancies('Продажи', bxSales, dbSalesSums, groups),
    ...collectDiscrepancies('Отгрузки', bxShip, dbShipSums, groups),
  ];

  const message = [
    [
      `[b]${config.header}[/b]\n[i]${weekdayRu(dateStr)}, ${fmtDateRu(dateStr)}[/i]`,
      planPercentSection('ДЕНЬ', bxSales.day, dayPlanSales, groups),
      planPercentSection('НЕДЕЛЯ', bxSales.week, weekPlanSales, groups),
      planPercentSection('МЕСЯЦ', bxSales.month, mtdPlanSales, groups),
    ].join('\n\n'),
    [
      conversionSection('Конверсия в бронь (месяц)', dbConv, groups, r => r.primaryReservations, r => r.primaryDeals),
      conversionSection('Конверсия в продажу (месяц)', dbConv, groups, r => r.primarySales, r => r.primaryDeals),
      conversionSection('Конверсия ППП (месяц)', dbConv, groups, r => r.ppp, r => r.primarySales),
      conversionSection('% повторных продаж (месяц)', dbConv, groups, r => r.repeatSales, r => r.primarySales + r.repeatSales),
    ].join('\n\n'),
    totalsBlock(
      config.totalTitle,
      mtdPlanSales[TOTAL_KEY], bxSales.month[TOTAL_KEY],
      mtdPlanShip[TOTAL_KEY], bxShip.month[TOTAL_KEY],
      config.totalsInRubles ?? false,
    ),
  ].join('\n\n————\n');

  const discrepancyMessage = `[b]Сверка Битрикс ↔ БД за ${fmtDateRu(dateStr)}[/b]\n` + (
    discrepancies.length > 0
      ? discrepancies.join('\n')
      : `Расхождений нет (порог ${DISCREPANCY_THRESHOLD / 1000} тыс ₽)`
  );

  return { dateStr, message, discrepancyMessage, discrepancies };
}

/** Отправляет отчёт двумя сообщениями (отчёт + сверка), как отчёт «МОСКВА». */
export async function sendGroupReport(
  dialogId: string, config: GroupReportConfig, reportDate?: string,
): Promise<GroupReportData> {
  const report = await buildGroupReport(config, reportDate);
  await sendBitrixBotMessage(dialogId, report.message);
  await sendBitrixBotMessage(dialogId, report.discrepancyMessage);
  return report;
}
