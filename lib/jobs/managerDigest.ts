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
import { getCurrencyName } from '@/features/badges/engine/coins';
import { getActiveEmployeeRoster } from '@/lib/org/employeeDirectory';
import {
  fetchManagerCustomers, fetchCategorySettings, classifyCategory,
  type CustomerRow, type CallSignal, type CustomerCategory,
} from '@/features/customers/engine/customers';
import {
  fetchCrossSellMatrix, recommendFor, fetchCrossSellBadges, badgeForPair,
} from '@/features/customers/engine/crossSell';
import { resolveClientNames } from '@/lib/bitrix/clientNames';

const TZ = 'Europe/Moscow';

// ── Даты (МСК, тот же стиль, что lib/jobs/dailyMoscowReport.ts) ──────────────

// Экспортированы (без изменения поведения) — задача 2769 (дайджест РОПа)
// переиспользует те же даты/форматирование МСК, чтобы дневной/недельный текст
// department-дайджеста не разъезжался с менеджерским по формату дат/сумм.
export function mskDateStr(d: Date = new Date()): string {
  const z = toZonedTime(d, TZ);
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`;
}
export function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7; // Пн=0 … Вс=6
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}
/** UTC-инстант московской полуночи данной даты — границы для timestamptz-запросов. */
export function mskMidnight(dateStr: string): Date {
  return fromZonedTime(`${dateStr} 00:00:00`, TZ);
}
export function fmtDateRu(dateStr: string): string {
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

// ── Скоринг подсказок «кому звонить» (правка владельца 02.08: «подсказывать
// только по реально высокошансовым») ─────────────────────────────────────────
// Явные веса + порог отсечки + порог «мёртвых» — миграция 137, редактируются в
// «Настройки → Геймификация → Дайджест». Веса калиброваны бэктестом по
// истории продаж (WORKLOG 02.08) — см. recencyFactorOverdue/isDead ниже.

export interface AdviceScoringSettings {
  scoreThreshold: number;
  weightRecency: number; weightFrequency: number; weightValue: number;
  weightResponsive: number; weightCrosssell: number;
  deadRatioThreshold: number; deadDaysThreshold: number;
}
export const DEFAULT_ADVICE_SCORING: AdviceScoringSettings = {
  scoreThreshold: 55,
  weightRecency: 35, weightFrequency: 15, weightValue: 20, weightResponsive: 10, weightCrosssell: 20,
  deadRatioThreshold: 5, deadDaysThreshold: 365,
};

export async function fetchAdviceScoringSettings(): Promise<AdviceScoringSettings> {
  try {
    const res = await systemDb().query<{
      advice_score_threshold: string; weight_recency: string; weight_frequency: string; weight_value: string;
      weight_responsive: string; weight_crosssell: string; dead_ratio_threshold: string; dead_days_threshold: number;
    }>(`SELECT advice_score_threshold, weight_recency, weight_frequency, weight_value,
               weight_responsive, weight_crosssell, dead_ratio_threshold, dead_days_threshold
          FROM digest_settings WHERE id = 1`);
    const r = res.rows[0];
    if (!r) return DEFAULT_ADVICE_SCORING;
    return {
      scoreThreshold: Number(r.advice_score_threshold),
      weightRecency: Number(r.weight_recency), weightFrequency: Number(r.weight_frequency),
      weightValue: Number(r.weight_value), weightResponsive: Number(r.weight_responsive),
      weightCrosssell: Number(r.weight_crosssell),
      deadRatioThreshold: Number(r.dead_ratio_threshold), deadDaysThreshold: Number(r.dead_days_threshold),
    };
  } catch { return DEFAULT_ADVICE_SCORING; } // до наката миграции 137 — дефолты
}

/**
 * Историческая доля возврата заказчика по бакетам «давность покупки / личный
 * цикл повторки» — бэктест 02.08 по ВСЕЙ истории sa.deals (заказчики с 3+
 * покупками, личный цикл — медиана их интервалов, как GLOBAL_REPEAT_CYCLE_DAYS
 * в customers.ts). Буквально «калибровка на истории»: фактор = реальная
 * доля тех, кто в этом бакете когда-либо покупал снова (см. WORKLOG 02.08 —
 * точные SQL и n на бакет). НЕ монотонно убывает линейно — реальные данные
 * показали характерный обрыв уже на 2-3x, не на 5x+, куда чаще целятся «на
 * глаз».
 */
function recencyFactorOverdue(ratio: number): number {
  if (ratio < 1) return 0.90;
  if (ratio < 2) return 0.93;
  if (ratio < 3) return 0.74;
  if (ratio < 5) return 0.62;
  if (ratio < 10) return 0.43;
  return 0.13;
}

/**
 * «Мёртвые не воскресают» (владелец 02.08): давность >= dead_ratio_threshold
 * циклов И > dead_days_threshold дней — жёсткое исключение из кандидатов,
 * не просто понижение веса. Порог по умолчанию (5x И 365 дн.) — эмпирический:
 * в этой зоне историческая доля возврата 3.1% (n=295), тогда как соседняя
 * зона 3-5x/<=365 дн. даёт 62% (n=405) — резать её было бы ошибкой (владелец
 * предлагал «условно >3×», бэктест показал, что это СЛИШКОМ агрессивно).
 * Правило применяется ТОЛЬКО к overdue_repeat — активная сделка без звонка
 * (active_no_call) не «спит», это открытая живая возможность независимо от
 * давности молчания по ней.
 */
function isDeadCandidate(row: CustomerRow, s: AdviceScoringSettings): boolean {
  if (!row.signals.includes('overdue_repeat') || row.lastSoldAt === null) return false;
  const sinceDays = (Date.now() - new Date(row.lastSoldAt).getTime()) / 86_400_000;
  const ratio = sinceDays / row.cycleDays;
  return ratio >= s.deadRatioThreshold && sinceDays > s.deadDaysThreshold;
}

const CATEGORY_VALUE_FACTOR: Record<CustomerCategory, number> = {
  key: 1, large: 0.8, regular: 0.5, once: 0.3, potential: 0.2, none: 0.15,
};

export interface AdviceScoreBreakdown {
  total: number; recency: number; frequency: number; value: number; responsive: number; crosssell: number;
  category: CustomerCategory;
}

/**
 * Взвешенный скор 0..~100 (сумма весов по умолчанию = 100, но настройка не
 * принуждает к этому — веса просто множители). Факторы:
 *  - recency — см. recencyFactorOverdue (overdue_repeat) или фикс. 0.9 для
 *    active_no_call (деньги на столе, тот же бэктест сюда не применялся —
 *    другой механизм, ургентность не зависит от давности так же линейно);
 *  - frequency — dealsSold, капед на 5 покупках;
 *  - value — категория заказчика (classifyCategory, тот же движок, что
 *    «Мои заказчики»/настройки категорий);
 *  - responsive — «реакция на прошлые касания»: ЧЕСТНАЯ ОГОВОРКА — точной
 *    атрибуции звонок→продажа нет, прокси = был ли вообще хоть один звонок
 *    по истории заказчика (lastCallAt не null). Грубо, но не выдумано —
 *    основано на реальном факте наличия контакта, не на догадке;
 *  - crosssell — вероятность перехода (pct из recommendFor), фолбэк на общий
 *    топ базы штрафуется низким фиксом (0.15) — «часто берут» вообще не то
 *    же самое, что «часто берут именно после этой покупки».
 */
function scoreCandidate(row: CustomerRow, pct: number, fallback: boolean, category: CustomerCategory, s: AdviceScoringSettings): AdviceScoreBreakdown {
  let recency: number;
  if (row.signals.includes('active_no_call')) {
    recency = 0.90;
  } else {
    const sinceDays = row.lastSoldAt ? (Date.now() - new Date(row.lastSoldAt).getTime()) / 86_400_000 : 0;
    recency = recencyFactorOverdue(sinceDays / row.cycleDays);
  }
  const frequency = Math.min(row.dealsSold / 5, 1);
  const value = CATEGORY_VALUE_FACTOR[category] ?? 0.15;
  const responsive = row.lastCallAt !== null ? 0.75 : 0.45;
  const crosssell = fallback ? 0.15 : Math.min(pct / 100, 1);

  const total =
    s.weightRecency * recency + s.weightFrequency * frequency + s.weightValue * value +
    s.weightResponsive * responsive + s.weightCrosssell * crosssell;
  return { total: Math.round(total * 10) / 10, recency, frequency, value, responsive, crosssell, category };
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
  // Задача 2820 (находка проверки 2818): раньше водило sa.employees — мёртвая
  // заготовка 13.06.2026, ни разу не обновлялась. На проверке 03.08 в ней
  // отсутствовало 222 из 429 активных сотрудников (52%) — значит 52% штата
  // НИКОГДА не получали дневной/недельный дайджест «Аналитик», хотя правило
  // владельца 02.08 («Пуш в Аналитик — обязателен», team/devops.md) требует
  // уведомление на КАЖДОЕ событие геймификации. Источник — единая функция
  // lib/org/employeeDirectory.ts (sa.org_resolved_hierarchy, ночной синк).
  const roster = await getActiveEmployeeRoster();
  return roster
    .map(e => ({ bitrixId: e.bitrixId, name: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
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

// Экспортирована для lib/jobs/ropDigest.ts (задача 2769) — тот же формат сумм
// в дайджесте РОПа, никакого параллельного форматтера.
export function fmtSum(v: number): string {
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

// Задача 2822 (правка владельца, после скриншота реального дайджеста):
// кликабельное имя заказчика ведёт НЕ в Битрикс, а в НАШ ЛК Монолитики
// («приучать людей пользоваться сервисом», дословно) — на уже существующую
// карточку заказчика (features/customers/ui/CustomerCard.tsx, ничего нового
// не строим), которой в задаче 2822 добавлена адресуемость через URL:
// /manager/<bitrixId>?tab=customers&customer=<clientKey> (см. ManagerCardPage.tsx
// и app/api/customers/route.ts::key=). /manager/<id>, а не /manager/me — так
// ссылка работает одинаково и для самого менеджера (получателя дайджеста), и
// для админа/директора, открывшего превью чужого дайджеста (canViewManager
// уже гейтит доступ на уровне страницы, ничего дополнительно проверять не
// нужно). Домен захардкожен по тому же принципу, что td.monolit-crm.ru в
// features/customers/ui/shared.ts::clientBitrixUrl — своего getPublicOrigin()
// у фонового job'а (без NextRequest) нет и не будет.
const MONOLITIKA_ORIGIN = 'https://monolitika.mlt-it.com';
export function buildCustomerLink(managerBitrixId: number, clientKey: string): string {
  return `${MONOLITIKA_ORIGIN}/manager/${managerBitrixId}?tab=customers&customer=${encodeURIComponent(clientKey)}`;
}

// Мусорные имена (задача 2822, со скриншота: «-», «000»; живой прогон
// доловил ещё «1» — голое число без единой буквы никого не идентифицирует,
// реальных юрлиц/контактов с названием из одних цифр не бывает) — не
// выводим вовсе, pickAdvice берёт следующего кандидата по скору (см. ниже).
function isJunkName(raw: string | null): boolean {
  if (raw === null) return true;
  const t = raw.trim();
  if (t === '') return true;
  if (/^[\s\-–—.]*$/.test(t)) return true; // только тире/точки/пробелы
  if (/^\d+$/.test(t)) return true;         // голое число: «0», «000», «1» — не идентифицирует человека/юрлицо
  return false;
}

/** Прямые кавычки ВНУТРИ самого названия (частый паттерн CRM: ООО "Название")
 *  — не оборачиваем ещё одной парой «» (баг со скриншота: «ООО "Название"»
 *  задвоенные кавычки), просто приводим к ёлочкам. */
function normalizeQuotes(raw: string): string {
  const first = raw.indexOf('"');
  const last = raw.lastIndexOf('"');
  if (first !== -1 && last !== -1 && first !== last) {
    return `${raw.slice(0, first)}«${raw.slice(first + 1, last)}»${raw.slice(last + 1)}`;
  }
  return raw;
}

/**
 * Единый вид имени/названия в дайджесте (задача 2822). Юрлицо — название без
 * задвоенных кавычек. Физлицо — полное имя, если оно в CRM есть; если имя из
 * ОДНОГО слова (частый случай — только имя без фамилии, со скриншота
 * «Валерий», непонятно кто) — добавляем уточнение по сумме последней сделки
 * (реальный, а не выдуманный признак — города/email в движке заказчиков нет).
 * null — имя мусорное или отсутствует, вызывающий код пропускает кандидата.
 */
function normalizeAdviceLabel(row: CustomerRow, rawName: string | null): string | null {
  if (isJunkName(rawName)) return null;
  // Живой прогон поймал «Белозеров Владимир Дмитриевич.» — лишняя точка в
  // хвосте одного из полей ФИО в самой CRM (не инициал — там имя целиком).
  // Снимаем ОДНУ висячую точку в конце (не трогаем многоточие/аббревиатуры
  // из нескольких точек — те не встречались, но на всякий случай не режем).
  let name = rawName!.trim().replace(/([^.])\.$/, '$1');
  if (row.clientType === 'company') {
    const q = normalizeQuotes(name);
    return q.includes('«') ? q : `«${q}»`;
  }
  // Живой прогон поймал «денис» рядом с «Кононок Эдуард Владимирович» — то же
  // «неоднородный вид» из брифа, только по регистру, не по составу слов.
  // Капитализируем ТОЛЬКО слова, набранные ЦЕЛИКОМ строчными — реальные ФИО
  // с намеренно смешанным регистром (двойные фамилии через дефис у нас не
  // встречались отдельно) капитализацию не потеряют.
  name = name.split(' ').map(w => (w === w.toLowerCase() && w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
  const isSingleWord = !/\s/.test(name);
  if (isSingleWord && row.lastSoldAmount) {
    return `${name} (сделка ~${fmtSum(row.lastSoldAmount)})`;
  }
  return name;
}

export interface AdvicePick {
  logDbId: number;
  row: CustomerRow;
  clientName: string;
  link: string;
  recommendedGroup: string;
  basedOnGroups: string[];
  fallback: boolean;
  pct: number;
  signal: CallSignal;
  score: AdviceScoreBreakdown;
  rewardHook: string | null;
}

const ADVICE_COOLDOWN_SQL = `
  SELECT client_key FROM advice_log
   WHERE manager_bitrix_id = $1 AND client_key = ANY($2::text[]) AND test_run = false
     AND (status IN ('active', 'contacted') OR (next_eligible_at IS NOT NULL AND next_eligible_at > now()))
`;

interface ScoredCandidate { row: CustomerRow; group: string; basedOn: string[]; fallback: boolean; pct: number; score: AdviceScoreBreakdown }

/**
 * Кандидаты «пора позвонить» → скоринг (владелец 02.08: «только реально
 * высокошансовые») → отсортировано по убыванию скора. Убраны: кому уже
 * советовали недавно/сейчас ведём открытую подсказку (cooldown, миграция
 * 134), «мёртвые» (isDeadCandidate), те, кому нечего честно предложить
 * (recommendFor вернул null), и те, кто не набрал score_threshold.
 */
async function scoredCandidates(managerBitrixId: number): Promise<ScoredCandidate[]> {
  const rows = await fetchManagerCustomers(managerBitrixId);
  const candidates = rows.filter(r => r.signals.length > 0);
  if (candidates.length === 0) return [];

  const [blocked, matrix, categorySettings, scoring] = await Promise.all([
    systemDb().query<{ client_key: string }>(ADVICE_COOLDOWN_SQL, [managerBitrixId, candidates.map(c => c.clientKey)])
      .then(r => new Set(r.rows.map(x => x.client_key))).catch(() => new Set<string>()),
    fetchCrossSellMatrix(),
    fetchCategorySettings(),
    fetchAdviceScoringSettings(),
  ]);

  const out: ScoredCandidate[] = [];
  for (const row of candidates) {
    if (blocked.has(row.clientKey)) continue;
    if (isDeadCandidate(row, scoring)) continue; // «мёртвые не воскресают» — не набираем баллы, не суём в кандидаты вовсе
    const lastGroups = row.lastSoldGroups.length > 0 ? row.lastSoldGroups : row.lastGroups;
    const rec = recommendFor(matrix, lastGroups);
    if (!rec || rec.items.length === 0) continue; // нечего честно предложить — пропускаем, не выдумываем
    const top = rec.items[0]!;
    const { category } = classifyCategory(row, categorySettings);
    const score = scoreCandidate(row, top.pct, rec.fallback, category, scoring);
    if (score.total < scoring.scoreThreshold) continue; // ниже порога — совета не будет вовсе (лучше только цифры, чем слабый совет)
    out.push({ row, group: top.group, basedOn: rec.basedOn, fallback: rec.fallback, pct: top.pct, score });
  }
  out.sort((a, b) => b.score.total - a.score.total);
  return out;
}

/** Выбирает до `limit` подсказок, пишет их в advice_log (одна строка на
 *  выданный совет — это и есть «журнал» из брифа) и возвращает готовые к
 *  форматированию карточки. testRun=true — для ручной проверки (не блокирует
 *  пару на будущее, помечается в БД, чистится отдельно). */
export async function pickAdvice(
  managerBitrixId: number, digestKind: 'daily' | 'weekly', limit: number, testRun = false,
): Promise<AdvicePick[]> {
  const scored = await scoredCandidates(managerBitrixId);
  if (scored.length === 0) return [];

  const picks: AdvicePick[] = [];
  // Буфер побольше limit — часть кандидатов может отсеяться мусорным именем
  // (задача 2822), нужен запас, чтобы не остаться с пустым списком там, где
  // реально были ещё нормальные кандидаты ниже по скору.
  let names = await resolveClientNames(scored.slice(0, limit + 8).map(s => s.row.clientKey));

  for (const cand of scored) {
    if (picks.length >= limit) break;
    const { row, group, basedOn, fallback, pct, score } = cand;
    let rawName = names.get(row.clientKey);
    if (rawName === undefined) { // кандидат за пределами буфера (много мусорных имён выше по списку) — доберём точечно
      const one = await resolveClientNames([row.clientKey]);
      rawName = one.get(row.clientKey) ?? null;
      names = new Map([...names, ...one]);
    }
    const clientName = normalizeAdviceLabel(row, rawName ?? null);
    if (clientName === null) continue; // мусорное/пустое имя (задача 2822) — не выдумываем, берём следующего кандидата

    const rewardHook = await fetchRewardHook(managerBitrixId, basedOn, group).catch(() => null);

    const ins = await systemDb().query<{ id: string }>(
      `INSERT INTO advice_log (manager_bitrix_id, client_key, client_type, client_id, client_name,
                                recommended_group, based_on_groups, fallback, confidence_pct, call_signal,
                                digest_kind, test_run)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [managerBitrixId, row.clientKey, row.clientType, row.clientId, clientName,
        group, basedOn, fallback, pct, row.signals[0] ?? null, digestKind, testRun],
    );

    picks.push({
      logDbId: Number(ins.rows[0]!.id),
      row, clientName, link: buildCustomerLink(managerBitrixId, row.clientKey),
      recommendedGroup: group, basedOnGroups: basedOn,
      fallback, pct, signal: row.signals[0]!, score, rewardHook,
    });
  }
  return picks;
}

// ── «Прикормка» (правка владельца 02.08): что реально светит за действие ────
// «Вернёшь заказчика после 570 дней тишины — заберёшь награду «Некромант» и
// 80 MLT на баланс. Дерзай!» Обязательные условия (владелец, дословно):
// проверять по РЕАЛЬНЫМ критериям и текущему состоянию менеджера (не
// упоминать, если награда уже есть или условие этим действием не выполнится);
// цену — из badge_prices, не хардкодить; если подходящей награды нет —
// строку не выводить вовсе; активный квест — приоритет над наградой (ценнее).
// ВАЖНО: это надстройка НАД уже отобранным по скорингу кандидатом — сначала
// scoredCandidates() решает, стоит ли вообще звонить, и только потом сюда
// подставляются basedOn/group УЖЕ выбранной пары. Прикормка никогда не влияет
// на то, кого выбрать (см. правку про скоринг выше) — только комментирует
// готовое решение.
async function fetchRewardHook(managerBitrixId: number, basedOnGroups: string[], recommendedGroup: string): Promise<string | null> {
  const db = systemDb();

  // 1) Активный квест — приоритет: «это ценнее» (владелец). Читаем НАПРЯМУЮ
  // из quests (не через ensureQuests/refreshQuests — те могут сгенерировать/
  // сроллить квесты как побочный эффект, здесь нужно только READ текущих).
  try {
    const questRes = await db.query<{
      id: string; category: string; target: string; target_group: string | null;
      pair_first: string | null; progress: string; title: string; reward_eballs: number;
    }>(
      `SELECT id, category, target, target_group, pair_first, progress, title, reward_eballs
         FROM quests WHERE bitrix_id = $1 AND status = 'active' AND category IN ('group_sales', 'crosssell')`,
      [managerBitrixId],
    );
    const quest = questRes.rows.find(q =>
      q.target_group === recommendedGroup
      && (q.category !== 'crosssell' || !q.pair_first || basedOnGroups.includes(q.pair_first)),
    );
    if (quest) {
      const currencyName = await getCurrencyName(db);
      const progress = Number(quest.progress);
      const target = Number(quest.target);
      const closes = progress + 1 >= target;
      // Компактно (задача 2822 — плотность блока): полный сгенерированный
      // title квеста («Допродай «Щебень» клиенту, купившему...до воскресенья»)
      // сюда НЕ идёт — раздул бы строку; кто продаёт, видит квест целиком в
      // табе «Квесты». «Дерзай!» — не здесь, один раз в конце всего блока
      // (см. buildAdviceSection) — иначе повторялось бы фразой на каждую строку.
      return closes
        ? `🎁 закроет квест, +${quest.reward_eballs} ${currencyName}`
        : `🎁 квест ${progress}→${progress + 1}/${target}, +${quest.reward_eballs} ${currencyName}`;
    }
  } catch { /* миграция 125 могла ещё не накатиться на этом инстансе — тихо пропускаем */ }

  // 2) Кросс-селл награда — тот же движок сопоставления, что уже используется
  // в «Мои заказчики» (badgeForPair): пара (basedOn → recommendedGroup) должна
  // РЕАЛЬНО матчить criteria включённой награды, цена — из badge_prices.
  if (basedOnGroups.length === 0) return null; // фолбэк-рекомендация — пары нет, награду не за что матчить
  try {
    const badges = await fetchCrossSellBadges();
    const badge = badgeForPair(badges, basedOnGroups, recommendedGroup);
    if (!badge || badge.price <= 0) return null; // нет награды за именно эту пару, или цена не задана — ничего не выдумываем
    const already = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM badge_awards WHERE bitrix_id = $1 AND badge_key = $2`,
      [managerBitrixId, badge.key],
    );
    if (Number(already.rows[0]?.n ?? '0') > 0) return null; // уже получена — упоминать нечего (владелец: «не должно быть враньём»)
    const currencyName = await getCurrencyName(db);
    return `🎁 «${badge.name}» +${badge.price} ${currencyName}`;
  } catch {
    return null; // таблиц наград ещё нет на этом инстансе — не роняем дайджест из-за бонусной строки
  }
}

// ── Блок подсказок: группировка по причине, без копипасты (задача 2822) ─────
// Скриншот реального дайджеста показал: три подсказки подряд, в каждой ПОЛНОСТЬЮ
// повторяется одна и та же 4-строчная конструкция — «выглядит как робот-копипаста»
// (владелец, дословно). Переделано: общая причина («нет контакта дольше цикла» /
// «активная сделка без звонка») выносится в заголовок ГРУППЫ один раз; если
// давность (цикл/дни тишины) у всех в группе совпадает — тоже в заголовок,
// иначе — индивидуально в строке. По каждому заказчику — только уникальное:
// имя (ссылкой), что купил → что предложить (%), прикормка (если есть).
// Жёсткое правило: ни одна ФРАЗА не встречается в сообщении дважды — общее
// сказано один раз в заголовке группы, «Дерзай!» — один раз в конце блока
// (если хоть где-то есть прикормка), а не на каждой строке.

/** Число, определяющее «совпадает ли причина у всех в группе»: для
 *  active_no_call — дней тишины по самой давней активной сделке; для
 *  overdue_repeat — личный цикл повторки заказчика (округлённый). */
function reasonValue(pick: AdvicePick): number {
  if (pick.signal === 'active_no_call') {
    return Math.round(Math.max(...pick.row.activeDeals.map(d => d.daysSilent), 0));
  }
  return Math.round(pick.row.cycleDays);
}

function groupHeader(signal: CallSignal, uniformValue: number | null): string {
  if (signal === 'active_no_call') {
    return uniformValue !== null
      ? `[b]Активная сделка без звонка уже ~${uniformValue} дн.:[/b]`
      : '[b]Активная сделка без звонка:[/b]';
  }
  return uniformValue !== null
    ? `[b]Нет контакта дольше обычного цикла (~${uniformValue} дн.):[/b]`
    : '[b]Нет контакта дольше обычного цикла:[/b]';
}

function buildAdviceSection(picks: AdvicePick[]): string[] {
  if (picks.length === 0) return [];
  const lines: string[] = [];

  // Группировка СТРОГО по причине (владелец: «группируй по причине, а не
  // сваливай в одну шапку») — сохраняем порядок первого появления сигнала.
  const order: CallSignal[] = [];
  const bySignal = new Map<CallSignal, AdvicePick[]>();
  for (const p of picks) {
    if (!bySignal.has(p.signal)) order.push(p.signal);
    (bySignal.get(p.signal) ?? bySignal.set(p.signal, []).get(p.signal)!).push(p);
  }

  let anyReward = false;
  for (const signal of order) {
    const group = bySignal.get(signal)!;
    const values = group.map(reasonValue);
    const uniform = values.every(v => v === values[0]) ? values[0] : null;
    lines.push(groupHeader(signal, uniform));
    for (const p of group) {
      // Давность разная внутри группы (владелец: «не выноси в шапку, показывай
      // индивидуально») — дописываем к конкретному заказчику.
      const valueSuffix = uniform === null ? ` (${reasonValue(p)} дн.)` : '';
      const hasOffer = !p.fallback && p.basedOnGroups.length > 0;
      const offerStr = hasOffer
        ? `${p.basedOnGroups.map(g => `«${g}»`).join(' + ')} → «${p.recommendedGroup}» (${p.pct}%)`
        : 'нет чёткой пары — смотри карточку';
      const rewardSuffix = p.rewardHook ? ` ${p.rewardHook}` : '';
      if (p.rewardHook) anyReward = true;
      lines.push(`• [URL=${p.link}]${p.clientName}[/URL]${valueSuffix} — ${offerStr}${rewardSuffix}`);
    }
  }
  if (anyReward) lines.push('Дерзай! 😎');
  return lines;
}

// ── Сборка сообщений ──────────────────────────────────────────────────────────

function hamburgerText(slots: HamburgerSlot[]): string[] {
  return slots.map(s => s.text);
}

export function buildDailyDigestMessage(dateStr: string, hamburger: HamburgerSlot[], advice: AdvicePick[], includeNumbers: boolean, includeAdvice: boolean): string {
  const lines = [`[b]Доброе утро! Дайджест за ${fmtDateRu(dateStr)}[/b]`];
  if (includeNumbers && hamburger.length > 0) lines.push('', ...hamburgerText(hamburger));
  else if (includeNumbers) lines.push('', 'Сегодня без ярких цифр — не за что особо ни похвалить, ни поругать 🙂');
  if (includeAdvice && advice.length > 0) lines.push('', ...buildAdviceSection(advice));
  return lines.join('\n');
}

export function buildWeeklyDigestMessage(weekLabel: string, hamburger: HamburgerSlot[], advice: AdvicePick[], includeNumbers: boolean, includeAdvice: boolean): string {
  const lines = [`[b]Итоги недели (${weekLabel})[/b]`];
  if (includeNumbers && hamburger.length > 0) lines.push('', ...hamburgerText(hamburger));
  else if (includeNumbers) lines.push('', 'На этой неделе без ярких цифр.');
  if (includeAdvice && advice.length > 0) {
    lines.push('', '[b]Кому стоит позвонить на этой неделе:[/b]', ...buildAdviceSection(advice));
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
  const message = buildDailyDigestMessage(dateStr, hamburger, picks, prefs.adviceNumbers, prefs.adviceCustomers);

  const trace = {
    manager: { bitrixId: m.bitrixId, name: m.name }, dateStr, metrics,
    hamburgerSlots: hamburger.map(s => s.trace),
    advice: picks.map(p => ({ logDbId: p.logDbId, clientKey: p.row.clientKey, clientName: p.clientName, link: p.link, recommendedGroup: p.recommendedGroup, fallback: p.fallback, pct: p.pct, signal: p.signal, score: p.score, rewardHook: p.rewardHook })),
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
    advice: picks.map(p => ({ logDbId: p.logDbId, clientKey: p.row.clientKey, clientName: p.clientName, link: p.link, recommendedGroup: p.recommendedGroup, fallback: p.fallback, pct: p.pct, signal: p.signal, score: p.score, rewardHook: p.rewardHook })),
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
