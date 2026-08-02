// Дайджест «Аналитика» РОПу — агрегированный по отделу (задача 2769,
// продолжение задачи 2765 — владелец явно отложил эту часть отдельной
// задачей на приёмке, см. WORKLOG 02.08 «Не сделано в этом заходе»).
//
// ПЕРЕИСПОЛЬЗУЕТ инфраструктуру 2765 целиком, не строит параллельный
// конвейер: sendManagerBotMessage() — та же ЕДИНАЯ точка отправки (dry-run
// bot_settings.dry_run_managers + bot_outbound_log/decision_trace/ID-метка +
// кнопки «Ошибка»/«Полезно» — всё автоматически, обойти нельзя, см.
// features/badges/engine/notifications.ts); fetchDigestSettings() —
// ТЕ ЖЕ часы отправки daily/weekly и лимит напоминаний, что у менеджеров
// (отдельных настроек времени для РОПа не заводили — не просили); формат дат/
// сумм — экспортированные хелперы lib/jobs/managerDigest.ts (mskDateStr и т.д.,
// fmtSum) — тот же стиль текста, никакого второго форматтера.
//
// «ОТДЕЛ РОПа» = прямые подчинённые по sa.org_resolved_hierarchy.rop_bitrix_
// user_id — ТОТ ЖЕ столбец, что уже использует эскалация «Контроля звонков»
// (lib/org/callControlScope.ts), НЕ department_id/user_departments (та
// иерархия — админские ручные назначения «Руководит» для карточки отдела в
// UI, у нас цель другая: у КАЖДОГО реального РОПа дайджест должен появиться
// автоматически, без ручной настройки в «Настройках»).
//
// СЛУЖЕБНЫЕ УЗЛЫ (owner-инцидент 01.08, «Департамент ОС»/«Общие (штат)» —
// см. память feedback_analsteroid_exclude_service_org_nodes) — эмпирически
// проверено на живых данных (задача 2769, см. отчёт): личные intake-аккаунты
// глав отделов, «Общие (штат)» (деактивированные Caller-аккаунты), «Дирекция»,
// HR/стажёры/роботы — ВСЕ они имеют rop_bitrix_user_id = NULL (сами никому не
// подчинены как «менеджер»). Фильтр `WHERE rop_bitrix_user_id = $ropId`
// исключает их автоматически, БЕЗ денай-листа по имени — и как членов чужого
// отдела, и как фантомный «отдел» в пуле сравнения (группировка бенчмарка
// идёт по rop_bitrix_user_id, а не по department_id/branch, так что строка без
// ропа просто никуда не попадает).
//
// ГРАНИЦА (принцип владельца «Аналитик — кореш, не надзиратель», буквально
// как в managerDigest.ts): дайджест РОПу НЕ пересказывает переписку
// конкретного менеджера с ботом и не пишет «твой менеджер не отреагировал».
// Управленческие подсказки (пункт «крупные заказчики отдела без касания»)
// сознательно НЕ называют, какой именно менеджер ведёт заказчика — это уже
// был бы шаг к «сдаёт с потрохами» (ровно та грань, которую владелец явно
// запретил при приёмке 2765). Заказчик + факт молчания — рабочий показатель
// уровня CRM, тот же класс данных, что TeamCustomerStats на вкладке «Моя
// команда» (только там счётчик, а не имя, но принцип тот же: показатели
// работы, не поведение в переписке с ботом).

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { sendManagerBotMessage } from '@/features/badges/engine/notifications';
import { getMonthWorkingDays } from '@/lib/plans/dailyPlan';
import {
  mskDateStr, addDaysStr, mondayOf, mskMidnight, fmtDateRu, fmtSum,
  mskIsoWeekday, fetchDigestSettings,
  type HamburgerSlot, type PeriodMetrics,
} from '@/lib/jobs/managerDigest';
import {
  fetchManagerCustomers, fetchCategorySettings, classifyCategory, type CustomerRow,
} from '@/features/customers/engine/customers';
import { fetchByProductGroups } from '@/features/reports/engine/byProductGroups';
import { resolveClientNames } from '@/lib/bitrix/clientNames';
import type { DateRange } from '@/lib/period';

export { mskIsoWeekday }; // удобно инструментации импортировать из одного места

// ── Ростер отдела и список активных РОПов ────────────────────────────────────

export interface RopRef { bitrixId: number; name: string }
export interface DeptMember { bitrixId: number; name: string; shortLogin: string | null }

/** Все РОПы, у которых сейчас есть хотя бы один прямой подчинённый (по
 *  org_resolved_hierarchy.rop_bitrix_user_id, is_active) — источник для
 *  bulk-прогона `runDailyDigestForAllRops`. */
export async function fetchActiveRops(): Promise<RopRef[]> {
  const res = await analyticsDb().query<{ rop_bitrix_user_id: string; rop_name: string }>(
    `SELECT DISTINCT rop_bitrix_user_id, rop_name FROM sa.org_resolved_hierarchy
      WHERE is_active = true AND rop_bitrix_user_id IS NOT NULL AND rop_name IS NOT NULL
      ORDER BY rop_name`,
  );
  return res.rows.map(r => ({ bitrixId: Number(r.rop_bitrix_user_id), name: r.rop_name }));
}

/** Прямые подчинённые конкретного РОПа — «его отдел» для дайджеста. */
export async function fetchDeptRoster(ropBitrixId: number): Promise<DeptMember[]> {
  const res = await analyticsDb().query<{ manager_bitrix_user_id: string; manager_name: string; short_login: string | null }>(
    `SELECT manager_bitrix_user_id, manager_name, short_login FROM sa.org_resolved_hierarchy
      WHERE rop_bitrix_user_id = $1 AND is_active = true`,
    [String(ropBitrixId)],
  );
  return res.rows.map(r => ({ bitrixId: Number(r.manager_bitrix_user_id), name: r.manager_name, shortLogin: r.short_login }));
}

/** Есть ли у этого bitrix-пользователя хоть один прямой подчинённый прямо
 *  сейчас — гейт для UI («показывать ли настройки дайджеста отдела в ЛК»). */
export async function isActiveRop(bitrixId: number): Promise<boolean> {
  const res = await analyticsDb().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sa.org_resolved_hierarchy WHERE rop_bitrix_user_id = $1 AND is_active = true`,
    [String(bitrixId)],
  );
  return Number(res.rows[0]?.n ?? '0') > 0;
}

// ── Личные настройки подписки РОПа (миграция 138, по образцу manager_bot_prefs) ──

export interface RopBotPrefs { enabled: boolean; dailyDigest: boolean; weeklyDigest: boolean; showNumbers: boolean; showHints: boolean }
export const DEFAULT_ROP_BOT_PREFS: RopBotPrefs = { enabled: true, dailyDigest: true, weeklyDigest: true, showNumbers: true, showHints: true };

export async function fetchRopBotPrefs(bitrixId: number): Promise<RopBotPrefs> {
  try {
    const res = await systemDb().query<{
      enabled: boolean; daily_digest: boolean; weekly_digest: boolean; show_numbers: boolean; show_hints: boolean;
    }>('SELECT enabled, daily_digest, weekly_digest, show_numbers, show_hints FROM rop_bot_prefs WHERE bitrix_id = $1', [bitrixId]);
    const r = res.rows[0];
    if (!r) return DEFAULT_ROP_BOT_PREFS;
    return { enabled: r.enabled, dailyDigest: r.daily_digest, weeklyDigest: r.weekly_digest, showNumbers: r.show_numbers, showHints: r.show_hints };
  } catch { return DEFAULT_ROP_BOT_PREFS; } // до наката миграции 138 — дефолты (всё включено)
}

function subscriptionBlockReasonRop(prefs: RopBotPrefs, channel: 'daily' | 'weekly'): string | null {
  if (!prefs.enabled) return 'rop_opted_out_all';
  if (channel === 'daily' && !prefs.dailyDigest) return 'rop_opted_out_daily';
  if (channel === 'weekly' && !prefs.weeklyDigest) return 'rop_opted_out_weekly';
  return null;
}

// ── Цифры отдела за период vs предыдущий такой же период (сумма по ростеру) ─
// Тот же SQL-паттерн, что managerDigest.ts::queryPeriodMetrics, только
// `current_manager_id = ANY($managerIds)` вместо одного менеджера.

async function fetchDeptPeriodMetrics(managerIds: number[], curFrom: Date, curTo: Date, prevFrom: Date, prevTo: Date): Promise<PeriodMetrics> {
  if (managerIds.length === 0) return { salesCount: 0, salesCountPrev: 0, salesSum: 0, salesSumPrev: 0, calls: 0, callsPrev: 0 };
  const db = analyticsDb();
  const [salesRes, callsRes] = await Promise.all([
    db.query<{ sales_count: string; sales_sum: string; sales_count_prev: string; sales_sum_prev: string }>(
      `SELECT
         count(*) FILTER (WHERE sold_at >= $2 AND sold_at < $3)::text AS sales_count,
         COALESCE(sum(amount) FILTER (WHERE sold_at >= $2 AND sold_at < $3), 0)::text AS sales_sum,
         count(*) FILTER (WHERE sold_at >= $4 AND sold_at < $5)::text AS sales_count_prev,
         COALESCE(sum(amount) FILTER (WHERE sold_at >= $4 AND sold_at < $5), 0)::text AS sales_sum_prev
       FROM sa.deals
       WHERE current_manager_id = ANY($1) AND sold_at IS NOT NULL`,
      [managerIds, curFrom.toISOString(), curTo.toISOString(), prevFrom.toISOString(), prevTo.toISOString()],
    ),
    db.query<{ calls: string; calls_prev: string }>(
      `SELECT
         count(*) FILTER (WHERE c.called_at >= $2 AND c.called_at < $3)::text AS calls,
         count(*) FILTER (WHERE c.called_at >= $4 AND c.called_at < $5)::text AS calls_prev
       FROM va.calls c JOIN sa.deals d ON d.deal_id = c.deal_id
       WHERE d.current_manager_id = ANY($1)`,
      [managerIds, curFrom.toISOString(), curTo.toISOString(), prevFrom.toISOString(), prevTo.toISOString()],
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

// ── Бенчмарк «сравнение с другими отделами и с лучшим отделом компании» ─────
// «Отдел» здесь = группировка по rop_bitrix_user_id (тот же ключ, что и
// ростер) — единственная группировка, которая одновременно (а) совпадает с
// тем, что видит РОП как «свой отдел», и (б) естественно исключает служебные
// узлы (см. шапку файла). Один проход по sa.deals + один по org_resolved_
// hierarchy — сумма по департаментам считается в JS (тот же приём, что
// managerDigest.ts::fetchSalesBenchmark, только группировка по rop, а не по
// branch+category).

interface DeptSalesBenchmark { otherAvgSalesSum: number; otherAvgSalesCount: number; bestSalesSum: number; bestSalesCount: number; peers: number }

async function fetchDeptSalesBenchmark(ropBitrixId: number, from: Date, to: Date): Promise<DeptSalesBenchmark | null> {
  const db = analyticsDb();
  const [salesRes, orgRes] = await Promise.all([
    db.query<{ mgr: string; sales_count: string; sales_sum: string }>(
      `SELECT current_manager_id::text AS mgr, count(*)::text AS sales_count, COALESCE(sum(amount),0)::text AS sales_sum
         FROM sa.deals
        WHERE sold_at >= $1 AND sold_at < $2 AND current_manager_id IS NOT NULL
        GROUP BY 1`,
      [from.toISOString(), to.toISOString()],
    ),
    db.query<{ manager_bitrix_user_id: string; rop_bitrix_user_id: string }>(
      `SELECT manager_bitrix_user_id, rop_bitrix_user_id FROM sa.org_resolved_hierarchy
        WHERE is_active = true AND rop_bitrix_user_id IS NOT NULL`,
    ),
  ]);
  const ropByMgr = new Map(orgRes.rows.map(r => [r.manager_bitrix_user_id, r.rop_bitrix_user_id]));

  const byRop = new Map<string, { salesSum: number; salesCount: number }>();
  for (const r of salesRes.rows) {
    const rop = ropByMgr.get(r.mgr);
    if (!rop) continue; // менеджер без РОПа (служебный узел) — ни в один отдел не считается
    const agg = byRop.get(rop) ?? { salesSum: 0, salesCount: 0 };
    agg.salesSum += Number(r.sales_sum);
    agg.salesCount += Number(r.sales_count);
    byRop.set(rop, agg);
  }

  const others = [...byRop.entries()].filter(([rop]) => rop !== String(ropBitrixId));
  if (others.length === 0) return null; // сравнивать не с кем (единственный отдел с продажами)
  const otherSumTotal = others.reduce((s, [, a]) => s + a.salesSum, 0);
  const otherCountTotal = others.reduce((s, [, a]) => s + a.salesCount, 0);
  let bestSum = 0, bestCount = 0;
  for (const [, a] of others) {
    if (a.salesSum > bestSum) bestSum = a.salesSum;
    if (a.salesCount > bestCount) bestCount = a.salesCount;
  }
  return {
    otherAvgSalesSum: otherSumTotal / others.length, otherAvgSalesCount: otherCountTotal / others.length,
    bestSalesSum: bestSum, bestSalesCount: bestCount, peers: others.length,
  };
}

// ── Брони отдела без прозвона (укор гамбургера — «тебе же хуже», в ₽) ───────

export interface BookingCallbackStat { total: number; called: number; riskSum: number }

// export — переиспользуется lib/jobs/ropAdviceFeedback.ts для повторной
// проверки «непрозвон отдела» на тике обратной связи (то же скользящее окно).
export async function fetchDeptBookingCallbackStat(managerIds: number[], from: Date, to: Date): Promise<BookingCallbackStat | null> {
  if (managerIds.length === 0) return null;
  const res = await analyticsDb().query<{ total: string; called: string; risk_sum: string }>(
    `WITH y AS (
       SELECT d.deal_id, d.amount,
              EXISTS (SELECT 1 FROM va.calls c WHERE c.deal_id = d.deal_id AND c.called_at >= d.reserved_at) AS was_called
         FROM sa.deals d
        WHERE d.current_manager_id = ANY($1) AND d.reserved_at >= $2 AND d.reserved_at < $3
     )
     SELECT count(*)::text AS total, count(*) FILTER (WHERE was_called)::text AS called,
            COALESCE(sum(amount) FILTER (WHERE NOT was_called), 0)::text AS risk_sum
       FROM y`,
    [managerIds, from.toISOString(), to.toISOString()],
  );
  const r = res.rows[0];
  if (!r || Number(r.total) === 0) return null;
  return { total: Number(r.total), called: Number(r.called), riskSum: Math.round(Number(r.risk_sum)) };
}

// ── Темп плана отгрузок отдела (сумма планов по short_login ростера) ───────

async function fetchDeptPlanTempoPct(shortLogins: (string | null)[], managerIds: number[], dateStr: string): Promise<number | null> {
  const logins = shortLogins.filter((s): s is string => !!s);
  if (logins.length === 0 || managerIds.length === 0) return null;
  const monthFirstDay = `${dateStr.slice(0, 7)}-01`;

  const planRes = await systemDb().query<{ plan_shipments: string }>(
    `SELECT plan_shipments FROM manager_plans WHERE month = $1::date AND manager_login = ANY($2)`,
    [monthFirstDay, logins],
  );
  const planShip = planRes.rows.reduce((s, r) => s + (parseFloat(r.plan_shipments) || 0), 0);
  if (planShip <= 0) return null;

  const wd = await getMonthWorkingDays(monthFirstDay, dateStr);
  if (!wd || wd.total <= 0 || wd.passed <= 0) return null;
  const mtdPlan = planShip * (wd.passed / wd.total);
  if (mtdPlan <= 0) return null;

  const factRes = await analyticsDb().query<{ sum: string }>(
    `SELECT COALESCE(sum(amount), 0)::text AS sum FROM sa.deals
      WHERE current_manager_id = ANY($1) AND delivered_at >= $2 AND delivered_at < $3`,
    [managerIds, mskMidnight(monthFirstDay).toISOString(), mskMidnight(addDaysStr(dateStr, 1)).toISOString()],
  );
  const fact = Number(factRes.rows[0]?.sum ?? 0);
  return Math.round((fact / mtdPlan) * 100);
}

// ── Гамбургер отдела: похвала → укор → похвала (тот же тон, что у менеджера,
// см. managerDigest.ts — только цифры суммарные по отделу и бенчмарк идёт
// против ДРУГИХ ОТДЕЛОВ, а не против пиров того же branch+category) ─────────

function buildDeptSalesPraiseSlot(m: PeriodMetrics, bench: DeptSalesBenchmark | null): HamburgerSlot | null {
  const candidates: { label: string; cur: number; prev: number; fmt: (v: number) => string; bench?: { avg: number; best: number } }[] = [
    { label: 'Сумма продаж отдела', cur: m.salesSum, prev: m.salesSumPrev, fmt: fmtSum, bench: bench ? { avg: bench.otherAvgSalesSum, best: bench.bestSalesSum } : undefined },
    { label: 'Продажи отдела (шт)', cur: m.salesCount, prev: m.salesCountPrev, fmt: v => `${v} шт`, bench: bench ? { avg: bench.otherAvgSalesCount, best: bench.bestSalesCount } : undefined },
    { label: 'Звонки отдела', cur: m.calls, prev: m.callsPrev, fmt: v => `${v}` },
  ];
  let best: (typeof candidates)[number] | null = null;
  let bestPct = 0;
  for (const c of candidates) {
    if (c.cur <= c.prev) continue; // рост — обязательное условие похвалы, ничего не выдумываем
    const pct = c.prev > 0 ? ((c.cur - c.prev) / c.prev) * 100 : 100;
    if (pct > bestPct) { bestPct = pct; best = c; }
  }
  if (!best) return null;

  // Та же нейтральная конструкция без согласования рода/числа с меткой, что и
  // в managerDigest.ts (живой баг «Сумма продаж вырослИ» — не повторяем).
  let text = `Молодец! ${best.label}: рост на ${Math.round(bestPct)}% (${best.fmt(best.prev)} → ${best.fmt(best.cur)})!`;
  if (best.bench && best.bench.avg > 0) {
    text += best.cur >= best.bench.avg
      ? ` Это выше среднего по другим отделам (${best.fmt(best.bench.avg)}).`
      : ` Кстати, это пока ниже среднего по другим отделам (${best.fmt(best.bench.avg)}), но тренд правильный.`;
    if (best.bench.best > best.cur) text += ` У лучшего отдела компании сейчас — ${best.fmt(best.bench.best)}, есть к чему стремиться.`;
    else text += ` И твой отдел сейчас лучший в компании — 🔥`;
  }
  return {
    kind: 'praise', text,
    trace: { rule: 'dept_sales_praise_best_growth', metric: best.label, cur: best.cur, prev: best.prev, pct: Math.round(bestPct), otherAvg: best.bench?.avg ?? null, best: best.bench?.best ?? null, candidatesConsidered: candidates.map(c => c.label) },
  };
}

function buildDeptBookingReproachSlot(b: BookingCallbackStat, periodLabel: string): HamburgerSlot | null {
  if (b.called >= b.total) return null; // всё прозвонено — укорять не за что
  const pct = Math.round((b.called / b.total) * 100);
  let text = `Твой отдел прозвонил только ${pct}% ${periodLabel} броней (${b.called} из ${b.total})`;
  if (b.riskSum > 0) text += `, рискуете потерять ${fmtSum(b.riskSum)}`;
  text += '. По-хорошему надо прозванивать все брони — если план отдела не выполнится, потом не говори, что не предупреждал!';
  return { kind: 'reproach', text, trace: { rule: 'dept_booking_callback_shortfall', total: b.total, called: b.called, pct, riskSum: b.riskSum, periodLabel } };
}

function buildDeptPlanTempoSlot(pct: number): HamburgerSlot | null {
  if (pct < 85) return null;
  const text = pct >= 100
    ? `Темп выполнения плана отгрузок отдела на текущий день — ${pct}%! Так держать! Но это не повод расслабляться.`
    : `Темп выполнения плана отгрузок отдела на текущий день — ${pct}%, неплохо! Можно ещё поднажать.`;
  return { kind: 'praise', text, trace: { rule: 'dept_plan_tempo', pct } };
}

async function buildDailyDeptHamburger(ropId: number, roster: DeptMember[], dateStr: string, metrics: PeriodMetrics): Promise<HamburgerSlot[]> {
  const managerIds = roster.map(m => m.bitrixId);
  const shortLogins = roster.map(m => m.shortLogin);
  const from = mskMidnight(dateStr), to = mskMidnight(addDaysStr(dateStr, 1));
  const yFrom = mskMidnight(addDaysStr(dateStr, -1)), yTo = from;
  const [bench, booking, tempo] = await Promise.all([
    fetchDeptSalesBenchmark(ropId, from, to).catch(() => null),
    fetchDeptBookingCallbackStat(managerIds, yFrom, yTo).catch(() => null),
    fetchDeptPlanTempoPct(shortLogins, managerIds, dateStr).catch(() => null),
  ]);
  const slots: (HamburgerSlot | null)[] = [
    buildDeptSalesPraiseSlot(metrics, bench),
    booking ? buildDeptBookingReproachSlot(booking, 'вчерашних') : null,
    tempo !== null ? buildDeptPlanTempoSlot(tempo) : null,
  ];
  return slots.filter((s): s is HamburgerSlot => s !== null);
}

async function buildWeeklyDeptHamburger(ropId: number, roster: DeptMember[], mondayStr: string, metrics: PeriodMetrics): Promise<HamburgerSlot[]> {
  const managerIds = roster.map(m => m.bitrixId);
  const shortLogins = roster.map(m => m.shortLogin);
  const from = mskMidnight(mondayStr), to = mskMidnight(addDaysStr(mondayStr, 7));
  const [bench, booking, tempo] = await Promise.all([
    fetchDeptSalesBenchmark(ropId, from, to).catch(() => null),
    fetchDeptBookingCallbackStat(managerIds, from, to).catch(() => null),
    fetchDeptPlanTempoPct(shortLogins, managerIds, mskDateStr()).catch(() => null),
  ]);
  const slots: (HamburgerSlot | null)[] = [
    buildDeptSalesPraiseSlot(metrics, bench),
    booking ? buildDeptBookingReproachSlot(booking, 'недельных') : null,
    tempo !== null ? buildDeptPlanTempoSlot(tempo) : null,
  ];
  return slots.filter((s): s is HamburgerSlot => s !== null);
}

// ── Управленческие подсказки (миграция 138: rop_advice_log) ──────────────────
// Три источника (owner-бриф): просевшая конверсия по товарной группе,
// непрозвоненные брони отдела (в ₽), крупный заказчик отдела без касания.
// Каждая подсказка — отдельная строка в rop_advice_log с cooldown/reminder-
// циклом (см. lib/jobs/ropAdviceFeedback.ts) — ТА ЖЕ механика 2765
// (active→success/closed_no_contact/closed_no_deal, max digest_settings.
// max_reminders напоминаний), только предмет советования не «клиент
// конкретному менеджеру», а «отделу/группе/заказчику» РОПу.
//
// Приоритизация между тремя типами — по «цене бездействия в рублях»
// (costRub): непрозвон — реальный риск (сумма непрозвоненных броней),
// заказчик — сумма его прошлых покупок (капитал под угрозой), конверсия —
// ОЦЕНКА недополученной выручки (дельта конверсии × число сделок группы ×
// средний чек группы) — честно помечена «ориентировочно» в тексте, это не
// точный расчёт, а порядок величины для сравнения важности.

export interface DeptHintCandidate {
  hintType: 'conversion_drop' | 'unphoned_bookings' | 'stale_customer';
  targetKey: string;
  targetLabel: string;
  text: string;
  costRub: number;
  trace: Record<string, unknown>;
}

function round1(v: number): number { return Math.round(v * 10) / 10; }

async function buildConversionDropCandidate(managerIds: string[], period: DateRange, prevPeriod: DateRange, periodLabel: string): Promise<DeptHintCandidate | null> {
  if (managerIds.length === 0) return null;
  const [curRows, prevRows] = await Promise.all([
    fetchByProductGroups({ period, dealScope: 'all', clientType: 'all', productGroupMode: 'kc', managerIds }),
    fetchByProductGroups({ period: prevPeriod, dealScope: 'all', clientType: 'all', productGroupMode: 'kc', managerIds }),
  ]);
  const prevById = new Map(prevRows.map(r => [r.dimensionId, r]));
  const MIN_DEALS = 5;     // отсекаем шум на маленькой выборке — не выдумываем просадку из 2 сделок
  const MIN_DROP_PTS = 3;  // просадка < 3 п.п. — в пределах обычного шума

  let worst: { row: (typeof curRows)[number]; curCr: number; prevCr: number; dropPts: number; curDeals: number; prevDeals: number } | null = null;
  for (const cur of curRows) {
    const prev = prevById.get(cur.dimensionId);
    if (!prev) continue;
    const curDeals = cur.metrics.deals_count ?? 0;
    const prevDeals = prev.metrics.deals_count ?? 0;
    if (curDeals < MIN_DEALS || prevDeals < MIN_DEALS) continue;
    const curCr = (cur.metrics.sales_count ?? 0) / curDeals;
    const prevCr = (prev.metrics.sales_count ?? 0) / prevDeals;
    const dropPts = (prevCr - curCr) * 100;
    if (dropPts <= MIN_DROP_PTS) continue;
    if (!worst || dropPts > worst.dropPts) worst = { row: cur, curCr, prevCr, dropPts, curDeals, prevDeals };
  }
  if (!worst) return null;

  const curSalesAmount = (worst.row.metrics.primary_sales_amount ?? 0) + (worst.row.metrics.repeat_sales_amount ?? 0);
  const curSalesCount = worst.row.metrics.sales_count ?? 0;
  const avgCheck = curSalesCount > 0 ? curSalesAmount / curSalesCount : 0;
  const estLostRub = Math.round((worst.dropPts / 100) * worst.curDeals * avgCheck);
  const curCrPct = round1(worst.curCr * 100), prevCrPct = round1(worst.prevCr * 100), dropPtsR = round1(worst.dropPts);

  const text = `💡 Просела конверсия по группе «${worst.row.dimensionName}»: ${prevCrPct}% → ${curCrPct}% (−${dropPtsR} п.п.) ${periodLabel}.`
    + (estLostRub > 0 ? ` Ориентировочно недополучено — ${fmtSum(estLostRub)} (грубая оценка, не точный расчёт).` : '')
    + ' Стоит посмотреть, что изменилось по группе — цена, остатки, сервис.';

  return {
    hintType: 'conversion_drop', targetKey: worst.row.dimensionId, targetLabel: worst.row.dimensionName, text, costRub: estLostRub,
    trace: { rule: 'dept_conversion_drop', group: worst.row.dimensionName, curCrPct, prevCrPct, dropPts: dropPtsR, curDeals: worst.curDeals, prevDeals: worst.prevDeals, avgCheck: Math.round(avgCheck), estLostRub },
  };
}

/** Пересчёт CR конкретной товарной группы за скользящее окно (для тика
 *  обратной связи ropAdviceFeedback.ts — «отросла ли конверсия обратно»).
 *  null = недостаточно сделок в группе за окно, чтобы честно судить (тик
 *  трактует это как «recovery ещё не подтверждён», см. комментарий в
 *  ropAdviceFeedback.ts). */
export async function recheckDeptGroupConversion(managerIds: string[], groupId: string, windowDays = 7): Promise<{ curCrPct: number; deals: number } | null> {
  if (managerIds.length === 0) return null;
  const to = new Date();
  const from = new Date(to.getTime() - windowDays * 86_400_000);
  const rows = await fetchByProductGroups({ period: { from, to }, dealScope: 'all', clientType: 'all', productGroupMode: 'kc', managerIds });
  const row = rows.find(r => r.dimensionId === groupId);
  if (!row) return null;
  const deals = row.metrics.deals_count ?? 0;
  if (deals < 5) return null;
  const sales = row.metrics.sales_count ?? 0;
  return { curCrPct: round1((sales / deals) * 100), deals };
}

async function buildUnphonedBookingsCandidate(managerIds: number[]): Promise<DeptHintCandidate | null> {
  // Скользящее окно 7 дней (НЕ окно дайджеста) — эта подсказка персистентная
  // (следит за прогрессом до закрытия тиком ropAdviceFeedback.ts), окно
  // дайджеста (день/неделя) для этого слишком узкое или слишком широкое.
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86_400_000);
  const stat = await fetchDeptBookingCallbackStat(managerIds, from, to);
  if (!stat || stat.called >= stat.total) return null;
  const unphoned = stat.total - stat.called;
  const text = `💡 Непрозвоненные брони отдела за последние 7 дней: ${unphoned} из ${stat.total} без звонка`
    + (stat.riskSum > 0 ? `, на сумму ${fmtSum(stat.riskSum)}` : '')
    + '. Это уже забронированные деньги — стоит подтянуть звонки, пока не остыли.';
  return {
    hintType: 'unphoned_bookings', targetKey: 'dept', targetLabel: 'Непрозвоненные брони отдела', text, costRub: stat.riskSum,
    trace: { rule: 'dept_unphoned_bookings', total: stat.total, called: stat.called, unphoned, riskSum: stat.riskSum, windowDays: 7 },
  };
}

function customerDaysSilent(row: CustomerRow): number {
  if (row.signals.includes('active_no_call')) {
    return Math.round(Math.max(...row.activeDeals.map(d => d.daysSilent), 0));
  }
  if (row.lastSoldAt) return Math.round((Date.now() - new Date(row.lastSoldAt).getTime()) / 86_400_000);
  return 0;
}

/** До `limit` кандидатов «крупный заказчик отдела без касания» — берём
 *  ОБЪЕДИНЕНИЕ «Моих заказчиков» всех менеджеров ростера (тот же движок, что
 *  фича Серёги 01.08 — features/customers/engine/customers.ts, тот же приём
 *  ограничения конкурентности, что fetchTeamCustomerStats), фильтр —
 *  категория key/large И есть сигнал «пора позвонить». СОЗНАТЕЛЬНО НЕ
 *  указываем, чей это заказчик (какой менеджер ведёт) — см. шапку файла про
 *  границу «не сдавать менеджера с потрохами». */
async function buildStaleCustomerCandidates(managerIds: number[], limit: number): Promise<DeptHintCandidate[]> {
  if (managerIds.length === 0) return [];
  const CONCURRENCY = 4;
  const rows: CustomerRow[] = [];
  for (let i = 0; i < managerIds.length; i += CONCURRENCY) {
    const chunk = managerIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(id => fetchManagerCustomers(id).catch(() => [] as CustomerRow[])));
    for (const r of results) rows.push(...r);
  }
  const catSettings = await fetchCategorySettings();
  const candidates = rows
    .filter(r => r.signals.length > 0)
    // Задача 2776: локальный обход «клиента 'k0'» УБРАН — общий движок
    // customers.ts больше не производит склеенный client_key='k0' вообще
    // (фикс в features/customers/engine/clientKey.ts, разбор — owners-inbox/
    // customers-k0-merge-issue.md). company_id=0 теперь разъезжается по
    // contact_id (clientType всегда 'contact' для этой ветки) — условие
    // clientType==='company' && clientId===0 больше никогда не матчится
    // (у настоящих компаний clientId=company_id≠0 по построению формулы),
    // поэтому фильтр стал мёртвым кодом и удалён, а не оставлен «на всякий
    // случай» — оставленный мёртвый фильтр маскировал бы регрессию формулы
    // тишиной вместо явной ошибки.
    .map(r => ({ row: r, category: classifyCategory(r, catSettings).category }))
    .filter(c => c.category === 'key' || c.category === 'large')
    .sort((a, b) => b.row.sumSold - a.row.sumSold)
    .slice(0, Math.max(limit * 3, 3)); // запас — часть может попасть под cooldown в pickDeptHints

  if (candidates.length === 0) return [];
  const names = await resolveClientNames(candidates.map(c => c.row.clientKey));

  return candidates.map(({ row, category }) => {
    const name = names.get(row.clientKey) ?? (row.clientType === 'contact' ? `Заказчик #${row.clientId}` : `Компания #${row.clientId}`);
    const label = row.clientType === 'company' ? `«${name}»` : name;
    const daysSilent = customerDaysSilent(row);
    const categoryRu = category === 'key' ? 'ключевой' : 'крупный';
    const text = `💡 ${label} (${categoryRu} заказчик отдела): без контакта уже ${daysSilent} дн., сумма прошлых покупок — ${fmtSum(row.sumSold)}. Стоит свериться по CRM, кто ведёт заказчика, и напомнить о себе.`;
    return {
      hintType: 'stale_customer' as const, targetKey: row.clientKey, targetLabel: label, text, costRub: row.sumSold,
      trace: { rule: 'dept_stale_customer', clientKey: row.clientKey, category, daysSilent, sumSold: row.sumSold, signals: row.signals },
    };
  });
}

/** Cooldown — та же идея, что ADVICE_COOLDOWN_SQL в managerDigest.ts: не
 *  предлагать заново пару (rop, hintType, targetKey), пока по ней открыта
 *  строка (active/contacted) или не прошёл next_eligible_at. */
async function ropCooldownBlocked(ropId: number, candidates: { hintType: string; targetKey: string }[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const pairsSql = candidates.map((_, i) => `($${i * 2 + 2}::text, $${i * 2 + 3}::text)`).join(', ');
  const res = await systemDb().query<{ hint_type: string; target_key: string }>(
    `SELECT hint_type, target_key FROM rop_advice_log
      WHERE rop_bitrix_id = $1 AND test_run = false AND (hint_type, target_key) IN (${pairsSql})
        AND (status IN ('active', 'contacted') OR (next_eligible_at IS NOT NULL AND next_eligible_at > now()))`,
    [ropId, ...candidates.flatMap(c => [c.hintType, c.targetKey])],
  ).catch(() => ({ rows: [] as { hint_type: string; target_key: string }[] }));
  return new Set(res.rows.map(r => `${r.hint_type}:${r.target_key}`));
}

/** Собирает до `limit` подсказок, пишет их в rop_advice_log (журнал цикла
 *  обратной связи — см. lib/jobs/ropAdviceFeedback.ts) и возвращает готовые
 *  строки для сообщения. testRun=true — ручная проверка, не блокирует пару
 *  на будущее (помечается в БД, чистится отдельно — как advice_log). */
export async function pickDeptHints(
  ropId: number, managerIds: number[], digestKind: 'daily' | 'weekly',
  period: DateRange, prevPeriod: DateRange, limit: number, testRun = false,
): Promise<DeptHintCandidate[]> {
  const managerIdStrs = managerIds.map(String);
  const convPeriodLabel = digestKind === 'daily' ? 'за вчера' : 'за прошедшую неделю';

  const [conv, booking, stale] = await Promise.all([
    buildConversionDropCandidate(managerIdStrs, period, prevPeriod, convPeriodLabel).catch(() => null),
    buildUnphonedBookingsCandidate(managerIds).catch(() => null),
    buildStaleCustomerCandidates(managerIds, Math.max(limit, 2)).catch(() => [] as DeptHintCandidate[]),
  ]);

  let all: DeptHintCandidate[] = [conv, booking, ...stale].filter((c): c is DeptHintCandidate => c !== null);
  if (all.length === 0) return [];

  const blocked = await ropCooldownBlocked(ropId, all);
  all = all.filter(c => !blocked.has(`${c.hintType}:${c.targetKey}`));
  all.sort((a, b) => b.costRub - a.costRub);
  const picked = all.slice(0, limit);

  for (const c of picked) {
    await systemDb().query(
      `INSERT INTO rop_advice_log (rop_bitrix_id, hint_type, target_key, target_label, digest_kind, test_run, decision_trace)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ropId, c.hintType, c.targetKey, c.targetLabel, digestKind, testRun, JSON.stringify(c.trace)],
    ).catch(e => console.warn('[ropDigest] запись в rop_advice_log не удалась:', e instanceof Error ? e.message : e));
  }
  return picked;
}

// ── Сборка сообщений ──────────────────────────────────────────────────────────

export function buildDailyDeptDigestMessage(dateStr: string, hamburger: HamburgerSlot[], hints: DeptHintCandidate[], showNumbers: boolean, showHints: boolean): string {
  const lines = [`[b]Доброе утро! Дайджест отдела за ${fmtDateRu(dateStr)}[/b]`];
  if (showNumbers && hamburger.length > 0) lines.push('', ...hamburger.map(s => s.text));
  else if (showNumbers) lines.push('', 'Сегодня по отделу без ярких цифр — не за что особо ни похвалить, ни поругать 🙂');
  if (showHints && hints.length > 0) { lines.push(''); for (const h of hints) lines.push(h.text); }
  return lines.join('\n');
}

export function buildWeeklyDeptDigestMessage(weekLabel: string, hamburger: HamburgerSlot[], hints: DeptHintCandidate[], showNumbers: boolean, showHints: boolean): string {
  const lines = [`[b]Итоги недели по отделу (${weekLabel})[/b]`];
  if (showNumbers && hamburger.length > 0) lines.push('', ...hamburger.map(s => s.text));
  else if (showNumbers) lines.push('', 'На этой неделе по отделу без ярких цифр.');
  if (showHints && hints.length > 0) {
    lines.push('', '[b]На что стоит обратить внимание:[/b]');
    for (const h of hints) lines.push(h.text);
  }
  return lines.join('\n');
}

// ── Отправка одному РОПу (переиспользуется тестовым роутом) ────────────────
// Идёт через sendManagerBotMessage — тот же рубильник dry-run и та же система
// ID/кнопок «Ошибка»/«Полезно», что у менеджерского дайджеста. Личные
// настройки подписки (rop_bot_prefs) гейтят ТОЛЬКО реальную отправку —
// сообщение всегда формируется и логируется целиком.

export async function sendDailyDigestForRop(rop: RopRef, opts: { testRun?: boolean; deliverTo?: number } = {}): Promise<string> {
  const dateStr = mskDateStr();
  const prefs = opts.testRun ? DEFAULT_ROP_BOT_PREFS : await fetchRopBotPrefs(rop.bitrixId);
  const roster = await fetchDeptRoster(rop.bitrixId);
  const managerIds = roster.map(m => m.bitrixId);

  const from = mskMidnight(dateStr), to = mskMidnight(addDaysStr(dateStr, 1));
  const prevFrom = mskMidnight(addDaysStr(dateStr, -1)), prevTo = from;
  const metrics = await fetchDeptPeriodMetrics(managerIds, from, to, prevFrom, prevTo);
  const hamburger = prefs.showNumbers ? await buildDailyDeptHamburger(rop.bitrixId, roster, dateStr, metrics) : [];

  const period: DateRange = { from, to: mskMidnight(dateStr) };
  const prevPeriod: DateRange = { from: prevFrom, to: mskMidnight(addDaysStr(dateStr, -1)) };
  const hints = prefs.showHints ? await pickDeptHints(rop.bitrixId, managerIds, 'daily', period, prevPeriod, 1, opts.testRun ?? false) : [];

  const message = buildDailyDeptDigestMessage(dateStr, hamburger, hints, prefs.showNumbers, prefs.showHints);
  const trace = {
    rop: { bitrixId: rop.bitrixId, name: rop.name }, dateStr, deptSize: roster.length, metrics,
    hamburgerSlots: hamburger.map(s => s.trace), hints: hints.map(h => ({ hintType: h.hintType, targetKey: h.targetKey, costRub: h.costRub, trace: h.trace })),
    prefsApplied: prefs,
  };
  const suppressReason = opts.testRun ? null : subscriptionBlockReasonRop(prefs, 'daily');
  await sendManagerBotMessage(opts.deliverTo ?? rop.bitrixId, message, 'rop_digest_daily', `Дайджест отдела за ${dateStr} (${rop.name})`, { suppressReason, decisionTrace: trace });
  return message;
}

export async function sendWeeklyDigestForRop(rop: RopRef, opts: { testRun?: boolean; deliverTo?: number } = {}): Promise<string> {
  const today = mskDateStr();
  const lastMonday = addDaysStr(mondayOf(today), -7);
  const prefs = opts.testRun ? DEFAULT_ROP_BOT_PREFS : await fetchRopBotPrefs(rop.bitrixId);
  const roster = await fetchDeptRoster(rop.bitrixId);
  const managerIds = roster.map(m => m.bitrixId);

  const from = mskMidnight(lastMonday), to = mskMidnight(addDaysStr(lastMonday, 7));
  const metrics = await fetchDeptPeriodMetrics(managerIds, from, to, mskMidnight(addDaysStr(lastMonday, -7)), from);
  const hamburger = prefs.showNumbers ? await buildWeeklyDeptHamburger(rop.bitrixId, roster, lastMonday, metrics) : [];

  const period: DateRange = { from, to: mskMidnight(addDaysStr(lastMonday, 6)) };
  const prevPeriod: DateRange = { from: mskMidnight(addDaysStr(lastMonday, -7)), to: mskMidnight(addDaysStr(lastMonday, -1)) };
  const hints = prefs.showHints ? await pickDeptHints(rop.bitrixId, managerIds, 'weekly', period, prevPeriod, 3, opts.testRun ?? false) : [];

  const weekLabel = `${fmtDateRu(lastMonday)}–${fmtDateRu(addDaysStr(lastMonday, 6))}`;
  const message = buildWeeklyDeptDigestMessage(weekLabel, hamburger, hints, prefs.showNumbers, prefs.showHints);
  const trace = {
    rop: { bitrixId: rop.bitrixId, name: rop.name }, weekLabel, deptSize: roster.length, metrics,
    hamburgerSlots: hamburger.map(s => s.trace), hints: hints.map(h => ({ hintType: h.hintType, targetKey: h.targetKey, costRub: h.costRub, trace: h.trace })),
    prefsApplied: prefs,
  };
  const suppressReason = opts.testRun ? null : subscriptionBlockReasonRop(prefs, 'weekly');
  await sendManagerBotMessage(opts.deliverTo ?? rop.bitrixId, message, 'rop_digest_weekly', `Недельный дайджест отдела ${weekLabel} (${rop.name})`, { suppressReason, decisionTrace: trace });
  return message;
}

// ── Прогон по всем активным РОПам (вызывается из instrumentation.ts) ───────

export async function runDailyDigestForAllRops(): Promise<{ sent: number; failed: number }> {
  const rops = await fetchActiveRops();
  let sent = 0, failed = 0;
  for (const r of rops) {
    try { await sendDailyDigestForRop(r); sent++; }
    catch (e) { failed++; console.warn(`[ropDigest] дневной дайджест РОПу ${r.bitrixId} не ушёл:`, e instanceof Error ? e.message : e); }
  }
  return { sent, failed };
}

export async function runWeeklyDigestForAllRops(): Promise<{ sent: number; failed: number }> {
  const rops = await fetchActiveRops();
  let sent = 0, failed = 0;
  for (const r of rops) {
    try { await sendWeeklyDigestForRop(r); sent++; }
    catch (e) { failed++; console.warn(`[ropDigest] недельный дайджест РОПу ${r.bitrixId} не ушёл:`, e instanceof Error ? e.message : e); }
  }
  return { sent, failed };
}

export { fetchDigestSettings };
