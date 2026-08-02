// Дайджест «Аналитика» менеджеру (задача 2765, ТЗ Серёги 02.08): ежедневный
// (короткий, будни) и еженедельный (по понедельникам) пуш ботом «Аналитик» —
// «гамбургер» похвала→укор→похвала с реальными цифрами и трендом (правка
// владельца 02.08, образцы — см. buildSalesPraiseSlot/buildBookingReproachSlot/
// buildPlanTempoSlot ниже) + персональная подсказка «кому позвонить и что
// предложить», сделанная из движка «Мои заказчики» (features/customers/engine/*,
// фича Серёги 01.08 — сигналы «пора позвонить» + кросс-селл матрица,
// самоповторы уже исключены там же).
//
// Тон — «Аналитик — кореш, а не надзиратель» (правка владельца 02.08,
// дословно про параллельный ИИ-РОП «ебырь-террорист, сдаёт ропов с
// потрохами»): дайджест ГОВОРИТ С МЕНЕДЖЕРОМ О НЁМ САМОМ, никаких сообщений
// наверх РОПу/руководству. Укор — строго в формате «тебе же хуже, я
// предупредил» (цена бездействия в ₽ САМОМУ менеджеру), НИКОГДА «сообщу
// руководителю» и НИКАКИХ оценок личности — критикуем действие/цифру, не
// человека. Если данных на слот гамбургера нет — слот молча пропускается
// (buildDailyHamburger/buildWeeklyHamburger), а не выдумывается.
//
// Личные настройки менеджера (manager_bot_prefs, миграция 135): у КАЖДОГО
// менеджера есть право выключить дайджест целиком/частично — «это его личка».
// Видимость этих настроек — по разрешению action.subscriptions.view_all
// (директор+ read-only, РОП НЕ видит), сама фильтрация подписки — ниже.

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { sendManagerBotMessage } from '@/features/badges/engine/notifications';
import { getMonthWorkingDays } from '@/lib/plans/dailyPlan';
import {
  fetchManagerCustomers, type CustomerRow, type CallSignal,
} from '@/features/customers/engine/customers';
import { fetchCrossSellMatrix, recommendFor, type CrossSellMatrix } from '@/features/customers/engine/crossSell';
import { resolveClientNames } from '@/lib/bitrix/clientNames';

const TZ = 'Europe/Moscow';

// ── Даты (МСК, тот же стиль, что lib/jobs/dailyMoscowReport.ts) ──────────────

function mskDateStr(d: Date = new Date()): string {
  const z = toZonedTime(d, TZ);
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`;
}
function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7; // Пн=0 … Вс=6
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}
/** UTC-инстант московской полуночи данной даты — границы для timestamptz-запросов. */
function mskMidnight(dateStr: string): Date {
  return fromZonedTime(`${dateStr} 00:00:00`, TZ);
}
function fmtDateRu(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}
/** 1=Пн … 7=Вс, по МСК. */
export function mskIsoWeekday(d: Date = new Date()): number {
  const z = toZonedTime(d, TZ);
  const js = z.getDay(); // 0=Вс..6=Сб
  return js === 0 ? 7 : js;
}
export function mskHour(d: Date = new Date()): number {
  return toZonedTime(d, TZ).getHours();
}

// ── Настройки (глобальные — вкл/выкл дайджеста, час отправки) ───────────────

export interface DigestSettings {
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  dailyHour: number;
  weeklyHour: number;
  maxReminders: number;
}
export const DEFAULT_DIGEST_SETTINGS: DigestSettings = {
  dailyEnabled: true, weeklyEnabled: true, dailyHour: 8, weeklyHour: 8, maxReminders: 2,
};

export async function fetchDigestSettings(): Promise<DigestSettings> {
  try {
    const res = await systemDb().query<{
      daily_enabled: boolean; weekly_enabled: boolean; daily_hour: number; weekly_hour: number; max_reminders: number;
    }>('SELECT daily_enabled, weekly_enabled, daily_hour, weekly_hour, max_reminders FROM digest_settings WHERE id = 1');
    const r = res.rows[0];
    if (!r) return DEFAULT_DIGEST_SETTINGS;
    return {
      dailyEnabled: r.daily_enabled, weeklyEnabled: r.weekly_enabled,
      dailyHour: r.daily_hour, weeklyHour: r.weekly_hour, maxReminders: r.max_reminders,
    };
  } catch { return DEFAULT_DIGEST_SETTINGS; } // до наката миграции 134 — дефолты, тик просто не шлёт
}

// ── Личные настройки подписки менеджера (миграция 135) ───────────────────────
// Отсутствие строки = всё включено (дефолт для новых сотрудников, из брифа).
// Финансовые уведомления (переводы/начисления/выплаты/сгорание) СЮДА не
// заведены вообще — они вне этой таблицы и продолжают идти напрямую через
// pushViaAnalitik в своих местах (не тронуто задачей 2765).

export interface ManagerBotPrefs {
  enabled: boolean; dailyDigest: boolean; weeklyDigest: boolean; adviceCustomers: boolean; adviceNumbers: boolean;
}
export const DEFAULT_MANAGER_BOT_PREFS: ManagerBotPrefs = {
  enabled: true, dailyDigest: true, weeklyDigest: true, adviceCustomers: true, adviceNumbers: true,
};

export async function fetchManagerBotPrefs(bitrixId: number): Promise<ManagerBotPrefs> {
  try {
    const res = await systemDb().query<{
      enabled: boolean; daily_digest: boolean; weekly_digest: boolean; advice_customers: boolean; advice_numbers: boolean;
    }>('SELECT enabled, daily_digest, weekly_digest, advice_customers, advice_numbers FROM manager_bot_prefs WHERE bitrix_id = $1', [bitrixId]);
    const r = res.rows[0];
    if (!r) return DEFAULT_MANAGER_BOT_PREFS;
    return {
      enabled: r.enabled, dailyDigest: r.daily_digest, weeklyDigest: r.weekly_digest,
      adviceCustomers: r.advice_customers, adviceNumbers: r.advice_numbers,
    };
  } catch { return DEFAULT_MANAGER_BOT_PREFS; } // до наката миграции 135 — дефолты (всё включено)
}

/** Своя формулировка причины подавления для лога (дифференцирует от dry-run) —
 *  null, если подписка позволяет слать. */
function subscriptionBlockReason(prefs: ManagerBotPrefs, channel: 'daily' | 'weekly'): string | null {
  if (!prefs.enabled) return 'manager_opted_out_all';
  if (channel === 'daily' && !prefs.dailyDigest) return 'manager_opted_out_daily';
  if (channel === 'weekly' && !prefs.weeklyDigest) return 'manager_opted_out_weekly';
  return null;
}

// ── Ростер менеджеров ─────────────────────────────────────────────────────────

export interface ManagerRef { bitrixId: number; name: string }

export async function fetchActiveManagers(): Promise<ManagerRef[]> {
  const res = await analyticsDb().query<{ bitrix_id: number; full_name: string }>(
    `SELECT bitrix_id, full_name FROM sa.employees
      WHERE bitrix_id IS NOT NULL AND is_active = true AND full_name IS NOT NULL AND full_name <> ''
      ORDER BY full_name`,
  );
  return res.rows.map(r => ({ bitrixId: r.bitrix_id, name: r.full_name }));
}

// ── Отдел менеджера (для сравнения «со своим отделом» в гамбургере) ─────────

interface ManagerOrg { branch: string; category: string | null }
async function fetchManagerOrg(bitrixId: number): Promise<ManagerOrg | null> {
  const res = await analyticsDb().query<{ branch: string; category: string | null }>(
    `SELECT branch, category FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id = $1 AND is_active = true LIMIT 1`,
    [String(bitrixId)],
  );
  return res.rows[0] ?? null;
}

// ── Цифры менеджера за период vs предыдущий такой же период ─────────────────

export interface PeriodMetrics {
  salesCount: number; salesCountPrev: number;
  salesSum: number; salesSumPrev: number;
  calls: number; callsPrev: number;
}

async function queryPeriodMetrics(managerBitrixId: number, curFrom: Date, curTo: Date, prevFrom: Date, prevTo: Date): Promise<PeriodMetrics> {
  const db = analyticsDb();
  const [salesRes, callsRes] = await Promise.all([
    db.query<{ sales_count: string; sales_sum: string; sales_count_prev: string; sales_sum_prev: string }>(
      `SELECT
         count(*) FILTER (WHERE sold_at >= $2 AND sold_at < $3)::text AS sales_count,
         COALESCE(sum(amount) FILTER (WHERE sold_at >= $2 AND sold_at < $3), 0)::text AS sales_sum,
         count(*) FILTER (WHERE sold_at >= $4 AND sold_at < $5)::text AS sales_count_prev,
         COALESCE(sum(amount) FILTER (WHERE sold_at >= $4 AND sold_at < $5), 0)::text AS sales_sum_prev
       FROM sa.deals
       WHERE current_manager_id = $1 AND sold_at IS NOT NULL`,
      [managerBitrixId, curFrom.toISOString(), curTo.toISOString(), prevFrom.toISOString(), prevTo.toISOString()],
    ),
    db.query<{ calls: string; calls_prev: string }>(
      `SELECT
         count(*) FILTER (WHERE c.called_at >= $2 AND c.called_at < $3)::text AS calls,
         count(*) FILTER (WHERE c.called_at >= $4 AND c.called_at < $5)::text AS calls_prev
       FROM va.calls c JOIN sa.deals d ON d.deal_id = c.deal_id
       WHERE d.current_manager_id = $1`,
      [managerBitrixId, curFrom.toISOString(), curTo.toISOString(), prevFrom.toISOString(), prevTo.toISOString()],
    ),
  ]);
  const s = salesRes.rows[0]!;
  const c = callsRes.rows[0]!;
  return {
    salesCount: Number(s.sales_count), salesCountPrev: Number(s.sales_count_prev),
    salesSum: Math.round(Number(s.sales_sum)), salesSumPrev: Math.round(Number(s.sales_sum_prev)),
    calls: Number(c.calls), callsPrev: Number(c.calls_prev),
  };
}

export async function fetchDayMetrics(managerBitrixId: number, dateStr: string): Promise<PeriodMetrics> {
  const from = mskMidnight(dateStr), to = mskMidnight(addDaysStr(dateStr, 1));
  const prevFrom = mskMidnight(addDaysStr(dateStr, -1)), prevTo = from;
  return queryPeriodMetrics(managerBitrixId, from, to, prevFrom, prevTo);
}

export async function fetchWeekMetrics(managerBitrixId: number, mondayStr: string): Promise<PeriodMetrics> {
  // mondayStr = понедельник ЗАКОНЧИВШЕЙСЯ недели (для дайджеста в утро следующего пн).
  const from = mskMidnight(mondayStr), to = mskMidnight(addDaysStr(mondayStr, 7));
  const prevFrom = mskMidnight(addDaysStr(mondayStr, -7)), prevTo = from;
  return queryPeriodMetrics(managerBitrixId, from, to, prevFrom, prevTo);
}

// ── Бенчмарк отдела (для похвалы «это выше среднего по отделу») ─────────────

interface SalesBenchmark { deptAvgSalesSum: number; deptAvgSalesCount: number; bestSalesSum: number; bestSalesCount: number; peers: number }

async function fetchSalesBenchmark(managerBitrixId: number, from: Date, to: Date): Promise<SalesBenchmark | null> {
  const myOrg = await fetchManagerOrg(managerBitrixId);
  if (!myOrg) return null;
  const res = await analyticsDb().query<{ mgr: string; sales_count: string; sales_sum: string }>(
    `SELECT current_manager_id::text AS mgr,
            count(*)::text AS sales_count, COALESCE(sum(amount),0)::text AS sales_sum
       FROM sa.deals
      WHERE sold_at >= $1 AND sold_at < $2 AND current_manager_id IS NOT NULL
      GROUP BY 1`,
    [from.toISOString(), to.toISOString()],
  );
  const orgRes = await analyticsDb().query<{ manager_bitrix_user_id: string; branch: string; category: string | null }>(
    `SELECT manager_bitrix_user_id, branch, category FROM sa.org_resolved_hierarchy WHERE is_active = true`,
  );
  const orgById = new Map(orgRes.rows.map(r => [r.manager_bitrix_user_id, { branch: r.branch, category: r.category }]));

  let deptSum = 0, deptCount = 0, peers = 0, bestSum = 0, bestCount = 0;
  for (const r of res.rows) {
    const org = orgById.get(r.mgr);
    if (!org || org.branch !== myOrg.branch || org.category !== myOrg.category) continue;
    const s = Number(r.sales_sum), c = Number(r.sales_count);
    deptSum += s; deptCount += c; peers++;
    if (s > bestSum) bestSum = s;
    if (c > bestCount) bestCount = c;
  }
  if (peers === 0) return null;
  return { deptAvgSalesSum: deptSum / peers, deptAvgSalesCount: deptCount / peers, bestSalesSum: bestSum, bestSalesCount: bestCount, peers };
}

// ── Брони без прозвона (укор — «тебе же хуже», с ценой в ₽) ─────────────────

interface BookingCallbackStat { total: number; called: number; riskSum: number }

async function fetchBookingCallbackStat(managerBitrixId: number, from: Date, to: Date): Promise<BookingCallbackStat | null> {
  const res = await analyticsDb().query<{ total: string; called: string; risk_sum: string }>(
    `WITH y AS (
       SELECT d.deal_id, d.amount,
              EXISTS (SELECT 1 FROM va.calls c WHERE c.deal_id = d.deal_id AND c.called_at >= d.reserved_at) AS was_called
         FROM sa.deals d
        WHERE d.current_manager_id = $1 AND d.reserved_at >= $2 AND d.reserved_at < $3
     )
     SELECT count(*)::text AS total, count(*) FILTER (WHERE was_called)::text AS called,
            COALESCE(sum(amount) FILTER (WHERE NOT was_called), 0)::text AS risk_sum
       FROM y`,
    [managerBitrixId, from.toISOString(), to.toISOString()],
  );
  const r = res.rows[0];
  if (!r || Number(r.total) === 0) return null;
  return { total: Number(r.total), called: Number(r.called), riskSum: Math.round(Number(r.risk_sum)) };
}

// ── Темп плана отгрузок (вторая похвала, если у менеджера есть план) ────────

async function fetchPlanTempoPct(managerBitrixId: number, dateStr: string): Promise<number | null> {
  const monthFirstDay = `${dateStr.slice(0, 7)}-01`;
  const orhRes = await analyticsDb().query<{ short_login: string }>(
    `SELECT short_login FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id = $1 AND is_active = true AND short_login IS NOT NULL LIMIT 1`,
    [String(managerBitrixId)],
  );
  const shortLogin = orhRes.rows[0]?.short_login;
  if (!shortLogin) return null;

  const planRes = await systemDb().query<{ plan_shipments: string; plan_n: string | null }>(
    `SELECT plan_shipments, plan_n FROM manager_plans WHERE month = $1::date AND manager_login = $2`,
    [monthFirstDay, shortLogin],
  );
  const planShip = parseFloat(planRes.rows[0]?.plan_shipments ?? '0') || 0;
  if (planShip <= 0) return null;

  const wd = await getMonthWorkingDays(monthFirstDay, dateStr);
  if (!wd || wd.total <= 0 || wd.passed <= 0) return null;
  const mtdPlan = planShip * (wd.passed / wd.total);
  if (mtdPlan <= 0) return null;

  const factRes = await analyticsDb().query<{ sum: string }>(
    `SELECT COALESCE(sum(amount), 0)::text AS sum FROM sa.deals
      WHERE current_manager_id = $1 AND delivered_at >= $2 AND delivered_at < $3`,
    [managerBitrixId, mskMidnight(monthFirstDay).toISOString(), mskMidnight(addDaysStr(dateStr, 1)).toISOString()],
  );
  const fact = Number(factRes.rows[0]?.sum ?? 0);
  return Math.round((fact / mtdPlan) * 100);
}

// ── Форматирование чисел ─────────────────────────────────────────────────────

function fmtSum(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace('.', ',')} млн ₽`;
  if (Math.abs(v) >= 1_000) return `${Math.round(v / 1000)} тыс ₽`;
  return `${Math.round(v)} ₽`;
}

// ── Гамбургер: похвала → укор → похвала (правка владельца 02.08) ────────────
// Образцы владельца:
//  «Молодец! Конверсия по утеплителю выросла на 2 п.п.! (6% → 8%) Кстати, это
//   вполне средний показатель по отделу, но точно можно лучше. У лучшего
//   менеджера — 13%, есть к чему стремиться.»
//  «Ты сегодня прозвонил только 60% забронированных вчера сделок, рискуешь
//   потерять 677 000 руб. По-хорошему надо прозванивать все 100% сделок. Если
//   не выполнишь недельный план, не говори, что не предупреждал!»
//  «Темп выполнения плана отгрузок на текущий день аж 104%! Так держать! Но
//   имей в виду: это не повод расслабляться.»
// Каждый слот — ЧЕСТНАЯ похвала/укор по реальным цифрам; нет данных/не за что
// хвалить-укорять — слот молча пропускается (НЕ подменяется выдумкой).

export interface HamburgerSlot { kind: 'praise' | 'reproach'; text: string; trace: Record<string, unknown> }

function buildSalesPraiseSlot(m: PeriodMetrics, bench: SalesBenchmark | null): HamburgerSlot | null {
  const candidates: { label: string; cur: number; prev: number; fmt: (v: number) => string; bench?: { avg: number; best: number } }[] = [
    { label: 'Сумма продаж', cur: m.salesSum, prev: m.salesSumPrev, fmt: fmtSum, bench: bench ? { avg: bench.deptAvgSalesSum, best: bench.bestSalesSum } : undefined },
    { label: 'Продажи (шт)', cur: m.salesCount, prev: m.salesCountPrev, fmt: v => `${v} шт`, bench: bench ? { avg: bench.deptAvgSalesCount, best: bench.bestSalesCount } : undefined },
    { label: 'Звонки', cur: m.calls, prev: m.callsPrev, fmt: v => `${v}` },
  ];
  let best: (typeof candidates)[number] | null = null;
  let bestPct = 0;
  for (const c of candidates) {
    if (c.cur <= c.prev) continue; // рост — обязательное условие похвалы, ничего не выдумываем
    const pct = c.prev > 0 ? ((c.cur - c.prev) / c.prev) * 100 : 100;
    if (pct > bestPct) { bestPct = pct; best = c; }
  }
  if (!best) return null;

  // Нейтральная формулировка (правка владельца 02.08, живой баг «Сумма продаж
  // вырослИ» — род метки не согласован: «сумма» жен.р., «продажи»/«звонки»
  // мн.ч.). Вместо словаря родов на каждую метку — конструкция без глагола,
  // согласованного с меткой: «Метка: рост на X% (было → стало)».
  let text = `Молодец! ${best.label}: рост на ${Math.round(bestPct)}% (${best.fmt(best.prev)} → ${best.fmt(best.cur)})!`;
  if (best.bench && best.bench.avg > 0) {
    text += best.cur >= best.bench.avg
      ? ` Это выше среднего по отделу (${best.fmt(best.bench.avg)}).`
      : ` Кстати, это пока ниже среднего по отделу (${best.fmt(best.bench.avg)}), но тренд правильный.`;
    if (best.bench.best > best.cur) text += ` У лучшего в отделе сегодня — ${best.fmt(best.bench.best)}, есть к чему стремиться.`;
    else text += ` И ты сегодня лучший в отделе — 🔥`;
  }
  return {
    kind: 'praise', text,
    trace: { rule: 'sales_praise_best_growth', metric: best.label, cur: best.cur, prev: best.prev, pct: Math.round(bestPct), deptAvg: best.bench?.avg ?? null, deptBest: best.bench?.best ?? null, candidatesConsidered: candidates.map(c => c.label) },
  };
}

function buildBookingReproachSlot(b: BookingCallbackStat, periodLabel: string): HamburgerSlot | null {
  if (b.called >= b.total) return null; // всё прозвонено — укорять не за что
  const pct = Math.round((b.called / b.total) * 100);
  let text = `Ты прозвонил только ${pct}% ${periodLabel} броней (${b.called} из ${b.total})`;
  if (b.riskSum > 0) text += `, рискуешь потерять ${fmtSum(b.riskSum)}`;
  text += '. По-хорошему надо прозванивать все брони — если не выполнишь план, потом не говори, что не предупреждал!';
  return { kind: 'reproach', text, trace: { rule: 'booking_callback_shortfall', total: b.total, called: b.called, pct, riskSum: b.riskSum, periodLabel } };
}

function buildPlanTempoSlot(pct: number): HamburgerSlot | null {
  if (pct < 85) return null; // ниже — не тянет на похвалу, а второй укор в гамбургере не нужен (один укор — достаточно)
  const text = pct >= 100
    ? `Темп выполнения плана отгрузок на текущий день — ${pct}%! Так держать! Но это не повод расслабляться.`
    : `Темп выполнения плана отгрузок на текущий день — ${pct}%, неплохо! Можно ещё поднажать.`;
  return { kind: 'praise', text, trace: { rule: 'plan_tempo', pct } };
}

async function buildDailyHamburger(managerBitrixId: number, dateStr: string, metrics: PeriodMetrics): Promise<HamburgerSlot[]> {
  const from = mskMidnight(dateStr), to = mskMidnight(addDaysStr(dateStr, 1));
  const yFrom = mskMidnight(addDaysStr(dateStr, -1)), yTo = from;
  const [bench, booking, tempo] = await Promise.all([
    fetchSalesBenchmark(managerBitrixId, from, to).catch(() => null),
    fetchBookingCallbackStat(managerBitrixId, yFrom, yTo).catch(() => null),
    fetchPlanTempoPct(managerBitrixId, dateStr).catch(() => null),
  ]);
  const slots: (HamburgerSlot | null)[] = [
    buildSalesPraiseSlot(metrics, bench),
    booking ? buildBookingReproachSlot(booking, 'вчерашних') : null,
    tempo !== null ? buildPlanTempoSlot(tempo) : null,
  ];
  return slots.filter((s): s is HamburgerSlot => s !== null);
}

async function buildWeeklyHamburger(managerBitrixId: number, mondayStr: string, metrics: PeriodMetrics): Promise<HamburgerSlot[]> {
  const from = mskMidnight(mondayStr), to = mskMidnight(addDaysStr(mondayStr, 7));
  const [bench, booking, tempo] = await Promise.all([
    fetchSalesBenchmark(managerBitrixId, from, to).catch(() => null),
    fetchBookingCallbackStat(managerBitrixId, from, to).catch(() => null),
    fetchPlanTempoPct(managerBitrixId, mskDateStr()).catch(() => null),
  ]);
  const slots: (HamburgerSlot | null)[] = [
    buildSalesPraiseSlot(metrics, bench),
    booking ? buildBookingReproachSlot(booking, 'недельных') : null,
    tempo !== null ? buildPlanTempoSlot(tempo) : null,
  ];
  return slots.filter((s): s is HamburgerSlot => s !== null);
}

// ── Подсказка по клиенту (движок «Мои заказчики» + кросс-селл) ──────────────

export interface AdvicePick {
  logDbId: number;
  row: CustomerRow;
  clientName: string;
  recommendedGroup: string;
  basedOnGroups: string[];
  fallback: boolean;
  pct: number;
  signal: CallSignal;
}

const ADVICE_COOLDOWN_SQL = `
  SELECT client_key FROM advice_log
   WHERE manager_bitrix_id = $1 AND client_key = ANY($2::text[]) AND test_run = false
     AND (status IN ('active', 'contacted') OR (next_eligible_at IS NOT NULL AND next_eligible_at > now()))
`;

/** Кандидаты «пора позвонить» минус те, кому уже советовали недавно/сейчас
 *  ведём открытую подсказку (см. миграцию 134 — cooldown/дедуп по паре). */
async function eligibleCandidates(managerBitrixId: number): Promise<CustomerRow[]> {
  const rows = await fetchManagerCustomers(managerBitrixId);
  const candidates = rows.filter(r => r.signals.length > 0);
  if (candidates.length === 0) return [];
  const blocked = await systemDb().query<{ client_key: string }>(
    ADVICE_COOLDOWN_SQL, [managerBitrixId, candidates.map(c => c.clientKey)],
  ).then(r => new Set(r.rows.map(x => x.client_key))).catch(() => new Set<string>());
  return candidates.filter(c => !blocked.has(c.clientKey));
}

/** Выбирает до `limit` подсказок, пишет их в advice_log (одна строка на
 *  выданный совет — это и есть «журнал» из брифа) и возвращает готовые к
 *  форматированию карточки. testRun=true — для ручной проверки (не блокирует
 *  пару на будущее, помечается в БД, чистится отдельно). */
export async function pickAdvice(
  managerBitrixId: number, digestKind: 'daily' | 'weekly', limit: number, testRun = false,
): Promise<AdvicePick[]> {
  const candidates = await eligibleCandidates(managerBitrixId);
  if (candidates.length === 0) return [];

  const matrix: CrossSellMatrix = await fetchCrossSellMatrix();
  const picks: AdvicePick[] = [];
  const names = await resolveClientNames(candidates.slice(0, limit + 3).map(c => c.clientKey));

  for (const row of candidates) {
    if (picks.length >= limit) break;
    const lastGroups = row.lastSoldGroups.length > 0 ? row.lastSoldGroups : row.lastGroups;
    const rec = recommendFor(matrix, lastGroups);
    if (!rec || rec.items.length === 0) continue; // нечего честно предложить — пропускаем кандидата, не выдумываем
    const top = rec.items[0]!;
    const clientName = names.get(row.clientKey) ?? (row.clientType === 'contact' ? `Контакт #${row.clientId}` : `Компания #${row.clientId}`);

    const ins = await systemDb().query<{ id: string }>(
      `INSERT INTO advice_log (manager_bitrix_id, client_key, client_type, client_id, client_name,
                                recommended_group, based_on_groups, fallback, confidence_pct, call_signal,
                                digest_kind, test_run)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [managerBitrixId, row.clientKey, row.clientType, row.clientId, clientName,
        top.group, rec.basedOn, rec.fallback, top.pct, row.signals[0] ?? null, digestKind, testRun],
    );

    picks.push({
      logDbId: Number(ins.rows[0]!.id),
      row, clientName, recommendedGroup: top.group, basedOnGroups: rec.basedOn,
      fallback: rec.fallback, pct: top.pct, signal: row.signals[0]!,
    });
  }
  return picks;
}

// Ни склонений имени, ни родовых местоимений/глаголов (правка владельца
// 02.08, живые баги «позвонить Николай» и скрытое «у него»/«он брал» — ФИО
// из CRM склонять автоматически рискованно, а пол клиента нам неизвестен и
// не должен угадываться). «дн» без точки — намеренно, чтобы не подставлять
// «день/дня/дней» под число без словаря склонений.
function signalReason(row: CustomerRow, signal: CallSignal): string {
  if (signal === 'active_no_call') {
    const maxSilent = Math.round(Math.max(...row.activeDeals.map(d => d.daysSilent), 0));
    return `открыта сделка без звонков уже ${maxSilent} дн`;
  }
  return `нет контакта дольше обычного цикла (обычно возвращается за покупкой через ~${Math.round(row.cycleDays)} дн.)`;
}

function adviceLine(pick: AdvicePick, verbose: boolean): string {
  const { row, clientName, recommendedGroup, basedOnGroups, fallback, pct, signal } = pick;
  // Имя/компания — ИМЕНИТЕЛЬНАЯ метка перед двоеточием, не объект глагола
  // «позвонить» (тот требовал бы дательного падежа: «позвонить Николаю», а
  // автоматически склонять произвольные ФИО из CRM небезопасно).
  const label = row.clientType === 'company' ? `«${clientName}»` : clientName;
  const reason = signalReason(row, signal);
  if (fallback || basedOnGroups.length === 0) {
    return `💡 ${label}: пора позвонить — ${reason}. Что предложить — глянь карточку клиента, там видно, чем раньше интересовался клиент.`;
  }
  const basedOnStr = basedOnGroups.map(g => `«${g}»`).join(' + ');
  const tail = verbose ? ` (так уходит примерно ${pct}% похожих клиентов)` : '';
  return `💡 ${label}: пора позвонить — ${reason}. Есть покупка ${basedOnStr} — обычно следом берут «${recommendedGroup}»${tail}. Стоит предложить!`;
}

// ── Сборка сообщений ──────────────────────────────────────────────────────────

function hamburgerText(slots: HamburgerSlot[]): string[] {
  return slots.map(s => s.text);
}

export function buildDailyDigestMessage(dateStr: string, hamburger: HamburgerSlot[], advice: AdvicePick | null, includeNumbers: boolean, includeAdvice: boolean): string {
  const lines = [`[b]Доброе утро! Дайджест за ${fmtDateRu(dateStr)}[/b]`];
  if (includeNumbers && hamburger.length > 0) lines.push('', ...hamburgerText(hamburger));
  else if (includeNumbers) lines.push('', 'Сегодня без ярких цифр — не за что особо ни похвалить, ни поругать 🙂');
  if (includeAdvice && advice) { lines.push(''); lines.push(adviceLine(advice, false)); }
  return lines.join('\n');
}

export function buildWeeklyDigestMessage(weekLabel: string, hamburger: HamburgerSlot[], advice: AdvicePick[], includeNumbers: boolean, includeAdvice: boolean): string {
  const lines = [`[b]Итоги недели (${weekLabel})[/b]`];
  if (includeNumbers && hamburger.length > 0) lines.push('', ...hamburgerText(hamburger));
  else if (includeNumbers) lines.push('', 'На этой неделе без ярких цифр.');
  if (includeAdvice && advice.length > 0) {
    lines.push('', '[b]Кому стоит позвонить на этой неделе:[/b]');
    for (const a of advice) lines.push(adviceLine(a, true));
  }
  return lines.join('\n');
}

// ── Отправка одному менеджеру (переиспользуется тестовым роутом) ────────────
// Идёт через sendManagerBotMessage (features/badges/engine/notifications.ts) —
// ту же единую точку, что и вся геймификация: рубильник dry-run (правка
// владельца 02.08) и личные настройки подписки (manager_bot_prefs) применяются
// автоматически, обойти нельзя. Сообщение ВСЕГДА формируется и логируется
// (с полным следом решения) — реально уходит только если dry-run выключен И
// подписка менеджера это разрешает.

export async function sendDailyDigestForManager(m: ManagerRef, opts: { testRun?: boolean; deliverTo?: number } = {}): Promise<string> {
  const dateStr = mskDateStr();
  const prefs = opts.testRun ? DEFAULT_MANAGER_BOT_PREFS : await fetchManagerBotPrefs(m.bitrixId);
  const metrics = await fetchDayMetrics(m.bitrixId, dateStr);
  const hamburger = prefs.adviceNumbers ? await buildDailyHamburger(m.bitrixId, dateStr, metrics) : [];
  const picks = prefs.adviceCustomers ? await pickAdvice(m.bitrixId, 'daily', 1, opts.testRun ?? false) : [];
  const message = buildDailyDigestMessage(dateStr, hamburger, picks[0] ?? null, prefs.adviceNumbers, prefs.adviceCustomers);

  const trace = {
    manager: { bitrixId: m.bitrixId, name: m.name }, dateStr, metrics,
    hamburgerSlots: hamburger.map(s => s.trace),
    advice: picks.map(p => ({ logDbId: p.logDbId, clientKey: p.row.clientKey, recommendedGroup: p.recommendedGroup, fallback: p.fallback, pct: p.pct, signal: p.signal })),
    prefsApplied: prefs,
  };
  const suppressReason = opts.testRun ? null : subscriptionBlockReason(prefs, 'daily');
  await sendManagerBotMessage(opts.deliverTo ?? m.bitrixId, message, 'digest_daily', `Дайджест за ${dateStr} (${m.name})`, { suppressReason, decisionTrace: trace });
  return message;
}

export async function sendWeeklyDigestForManager(m: ManagerRef, opts: { testRun?: boolean; deliverTo?: number } = {}): Promise<string> {
  const today = mskDateStr();
  const lastMonday = addDaysStr(mondayOf(today), -7); // понедельник только что закончившейся недели
  const prefs = opts.testRun ? DEFAULT_MANAGER_BOT_PREFS : await fetchManagerBotPrefs(m.bitrixId);
  const metrics = await fetchWeekMetrics(m.bitrixId, lastMonday);
  const hamburger = prefs.adviceNumbers ? await buildWeeklyHamburger(m.bitrixId, lastMonday, metrics) : [];
  const picks = prefs.adviceCustomers ? await pickAdvice(m.bitrixId, 'weekly', 3, opts.testRun ?? false) : [];
  const weekLabel = `${fmtDateRu(lastMonday)}–${fmtDateRu(addDaysStr(lastMonday, 6))}`;
  const message = buildWeeklyDigestMessage(weekLabel, hamburger, picks, prefs.adviceNumbers, prefs.adviceCustomers);

  const trace = {
    manager: { bitrixId: m.bitrixId, name: m.name }, weekLabel, metrics,
    hamburgerSlots: hamburger.map(s => s.trace),
    advice: picks.map(p => ({ logDbId: p.logDbId, clientKey: p.row.clientKey, recommendedGroup: p.recommendedGroup, fallback: p.fallback, pct: p.pct, signal: p.signal })),
    prefsApplied: prefs,
  };
  const suppressReason = opts.testRun ? null : subscriptionBlockReason(prefs, 'weekly');
  await sendManagerBotMessage(opts.deliverTo ?? m.bitrixId, message, 'digest_weekly', `Недельный дайджест ${weekLabel} (${m.name})`, { suppressReason, decisionTrace: trace });
  return message;
}

// ── Прогон по всем активным менеджерам (вызывается из instrumentation.ts) ───

export async function runDailyDigestForAllManagers(): Promise<{ sent: number; failed: number }> {
  const managers = await fetchActiveManagers();
  let sent = 0, failed = 0;
  for (const m of managers) {
    try { await sendDailyDigestForManager(m); sent++; }
    catch (e) { failed++; console.warn(`[digest] дневной дайджест менеджеру ${m.bitrixId} не ушёл:`, e instanceof Error ? e.message : e); }
  }
  return { sent, failed };
}

export async function runWeeklyDigestForAllManagers(): Promise<{ sent: number; failed: number }> {
  const managers = await fetchActiveManagers();
  let sent = 0, failed = 0;
  for (const m of managers) {
    try { await sendWeeklyDigestForManager(m); sent++; }
    catch (e) { failed++; console.warn(`[digest] недельный дайджест менеджеру ${m.bitrixId} не ушёл:`, e instanceof Error ? e.message : e); }
  }
  return { sent, failed };
}
