// «Планёрка» — таб ЛК менеджера (задача владельца 01.08, одобрено Серёгой):
// текстовая сводка «где деньги, что делать, где рост, где падение» — ШАБЛОНАМИ
// из данных (без LLM), каждая цифра кликабельна в соответствующий список.
//
// Период: календарный объект (день/неделя/месяц, тот же движок, что быстрые
// пресеты отчётов — lib/period calendarUnitBounds/previousCalendarUnitBounds),
// offset — сколько объектов назад от текущего (0 = этот месяц/эта неделя/сегодня).
// Сравнение — ПРЕДЫДУЩИЙ календарный объект того же типа (не хвост той же длины) —
// консистентно с калькулятором пресетов отчётов (задача 10.07).
//
// Атрибуция сделок — current_manager_id (как везде: byManagers, bookingCallRate,
// customers.ts). «Продажа»/«бронь»/«отгрузка» — sold_at/reserved_at/delivered_at
// (эталон analsteroid, см. features/customers/engine/customers.ts шапка).

import { analyticsDb } from '@/lib/db/clients';
import {
  calendarUnitBounds, previousCalendarUnitBounds, toSqlInterval,
  type CalendarUnit, type DateRange,
} from '@/lib/period';
import { getOffloadModel, probabilityFor, type OffloadModel } from '@/features/offload/engine/model';
import { cutoffForHeadGroup } from '@/features/offload/engine/cutoffs';
import {
  fetchManagerCustomers, fetchCategorySettings, classifyCategory,
  type CustomerRow,
} from '@/features/customers/engine/customers';
import { computePeriodPlanByLogin } from '@/lib/plans/dailyPlan';

export type PlanyorkaUnit = Extract<CalendarUnit, 'day' | 'week' | 'month'>;

/** Эмпирическая вероятность, что клиент, вышедший за свой цикл повторки (сигнал
 *  overdue_repeat — см. customers.ts), КОГДА-ЛИБО купит снова. Посчитана SQL по
 *  живым данным 01.08.2026: среди клиентов с ≥3 покупками все «просроченные»
 *  разрывы между покупками (gap ≥ max(2×цикл клиента, 7дн), тот же порог, что
 *  AT_RISK_CYCLE_MULTIPLIER в customers.ts) — 1963 таких эпизода, из них 847
 *  впоследствии ЗАКРЫЛИСЬ следующей покупкой (не остались открытым хвостом) →
 *  847/1963 = 43.1%. ОГОВОРКА (сознательное упрощение по ТЗ): величина не
 *  бьётся по горизонту «купит В ЭТОМ периоде» — это оценка «купит вообще,
 *  когда-нибудь». Подлежит калибровке, если понадобится точность выше грубой
 *  прикидки диапазона потенциала.
 */
export const P_REPEAT_OVERDUE = 0.431;
/** Диапазон отображения потенциала (бриф: «диапазоном, например ±25%»). */
export const POTENTIAL_RANGE_PCT = 0.25;

function periodBounds(unit: PlanyorkaUnit, offset: number): { period: DateRange; compare: DateRange } {
  const now = new Date();
  let ref = now;
  // offset шагов календарного объекта назад от текущего (0 = текущий).
  for (let i = 0; i < Math.abs(offset); i++) {
    ref = previousCalendarUnitBounds(unit, ref).from;
  }
  const period = calendarUnitBounds(unit, ref);
  const compare = previousCalendarUnitBounds(unit, ref);
  return { period, compare };
}

// ── Блок 1: итоги периода vs предыдущий ──────────────────────────────────────

export interface PeriodTotals {
  salesCount: number; salesAmount: number;
  bookingsCount: number; bookingsAmount: number;
  shipmentsCount: number; shipmentsAmount: number;
}
export interface GroupDelta { group: string; amount: number; prevAmount: number; delta: number; deltaPct: number | null }

interface TotalsRow {
  sales_count: string; sales_amount: string | null;
  bookings_count: string; bookings_amount: string | null;
  shipments_count: string; shipments_amount: string | null;
}

async function fetchTotals(managerIdsNum: number[], fromIso: string, toExclIso: string): Promise<PeriodTotals> {
  if (managerIdsNum.length === 0) {
    return { salesCount: 0, salesAmount: 0, bookingsCount: 0, bookingsAmount: 0, shipmentsCount: 0, shipmentsAmount: 0 };
  }
  const res = await analyticsDb().query<TotalsRow>(
    `SELECT
       count(*) FILTER (WHERE sold_at >= $2 AND sold_at < $3) AS sales_count,
       COALESCE(sum(amount) FILTER (WHERE sold_at >= $2 AND sold_at < $3), 0) AS sales_amount,
       count(*) FILTER (WHERE reserved_at >= $2 AND reserved_at < $3) AS bookings_count,
       COALESCE(sum(amount) FILTER (WHERE reserved_at >= $2 AND reserved_at < $3), 0) AS bookings_amount,
       count(*) FILTER (WHERE delivered_at >= $2 AND delivered_at < $3) AS shipments_count,
       COALESCE(sum(amount) FILTER (WHERE delivered_at >= $2 AND delivered_at < $3), 0) AS shipments_amount
     FROM sa.deals WHERE current_manager_id = ANY($1::int[])`,
    [managerIdsNum, fromIso, toExclIso],
  );
  const r = res.rows[0];
  return {
    salesCount: Number(r?.sales_count ?? 0), salesAmount: Number(r?.sales_amount ?? 0),
    bookingsCount: Number(r?.bookings_count ?? 0), bookingsAmount: Number(r?.bookings_amount ?? 0),
    shipmentsCount: Number(r?.shipments_count ?? 0), shipmentsAmount: Number(r?.shipments_amount ?? 0),
  };
}

async function fetchGroupSales(managerIdsNum: number[], fromIso: string, toExclIso: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (managerIdsNum.length === 0) return out;
  const res = await analyticsDb().query<{ grp: string; amount: string }>(
    `SELECT COALESCE(NULLIF(head_group_name, ''), '(без группы)') AS grp, COALESCE(sum(amount), 0) AS amount
     FROM sa.deals
     WHERE current_manager_id = ANY($1::int[]) AND sold_at >= $2 AND sold_at < $3
     GROUP BY 1`,
    [managerIdsNum, fromIso, toExclIso],
  );
  for (const r of res.rows) out.set(r.grp, Number(r.amount));
  return out;
}

// ── Блок 2: потенциал / факт / упущенное ─────────────────────────────────────

interface OpenDealRow {
  deal_id: number; amount: string | null; head_group: string | null;
  work_days: string | null; is_repeat: boolean; stage_group: 'new' | 'work';
}

async function fetchOpenDealsForManager(managerIdNum: number): Promise<OpenDealRow[]> {
  const res = await analyticsDb().query<OpenDealRow>(
    `WITH open_deals AS (
       SELECT d.deal_id, d.amount, d.head_group_name AS head_group, d.stage_id, f.is_repeat,
              CASE WHEN s.stage_type = 'NEW' THEN 'new' ELSE 'work' END AS stage_group
       FROM deals d
       JOIN stages s ON s.id = d.stage_id
       JOIN funnels f ON f.id = d.funnel_id
       WHERE d.current_manager_id = $1
         AND (s.stage_type = 'NEW' OR (s.stage_type = 'WORK' AND s.event_type NOT IN ('sold','shipped')))
     ),
     work_stages AS (SELECT id FROM stages WHERE stage_type = 'WORK' AND event_type NOT IN ('sold','shipped')),
     ev AS (
       SELECT de.deal_id, de.stage_id, de.event_at,
              LEAD(de.event_at) OVER (PARTITION BY de.deal_id ORDER BY de.event_at) AS next_at
       FROM deal_events de WHERE de.deal_id IN (SELECT deal_id FROM open_deals)
     ),
     wt AS (
       SELECT ev.deal_id, SUM(EXTRACT(EPOCH FROM COALESCE(ev.next_at, now()) - ev.event_at)) / 86400.0 AS work_days
       FROM ev JOIN work_stages ws ON ws.id = ev.stage_id GROUP BY ev.deal_id
     )
     SELECT od.deal_id, od.amount, od.head_group, od.is_repeat, od.stage_group, COALESCE(wt.work_days, 0) AS work_days
     FROM open_deals od LEFT JOIN wt ON wt.deal_id = od.deal_id`,
    [managerIdNum],
  );
  return res.rows;
}

export interface PotentialItem {
  kind: 'open_deal' | 'expected_repeat';
  label: string; amount: number; probability: number; clientKey?: string;
}
export interface PotentialBreakdown {
  totalMid: number; totalLow: number; totalHigh: number;
  fromOpenDeals: number; fromExpectedRepeat: number;
  items: PotentialItem[]; // топ-строки разворота, сортировка amount×P убыв.
}

async function computePotential(managerIdNum: number, model: OffloadModel, customers: CustomerRow[]): Promise<PotentialBreakdown> {
  const openDeals = await fetchOpenDealsForManager(managerIdNum);
  const items: PotentialItem[] = [];
  let fromOpenDeals = 0;
  for (const d of openDeals) {
    // Модель — ТОЛЬКО первичка (probabilityFor документировано так же в offload) —
    // у повторки P не определена, в потенциал не включаем (то же решение, что offload).
    if (d.is_repeat) continue;
    const amount = Number(d.amount ?? 0);
    const workDays = Number(d.work_days ?? 0);
    const p = probabilityFor(model, d.head_group, workDays);
    const val = amount * p;
    fromOpenDeals += val;
    items.push({ kind: 'open_deal', label: `Сделка #${d.deal_id} (${d.head_group ?? '(без группы)'})`, amount, probability: p });
  }

  let fromExpectedRepeat = 0;
  for (const c of customers) {
    if (!c.signals.includes('overdue_repeat')) continue;
    const avgCheck = c.dealsSold > 0 ? c.sumSold / c.dealsSold : 0;
    const val = avgCheck * P_REPEAT_OVERDUE;
    fromExpectedRepeat += val;
    items.push({ kind: 'expected_repeat', label: c.name ?? `Клиент ${c.clientKey}`, amount: avgCheck, probability: P_REPEAT_OVERDUE, clientKey: c.clientKey });
  }

  items.sort((a, b) => (b.amount * b.probability) - (a.amount * a.probability));
  const totalMid = fromOpenDeals + fromExpectedRepeat;
  return {
    totalMid, totalLow: totalMid * (1 - POTENTIAL_RANGE_PCT), totalHigh: totalMid * (1 + POTENTIAL_RANGE_PCT),
    fromOpenDeals, fromExpectedRepeat, items: items.slice(0, 20),
  };
}

export interface MissedBreakdown {
  refusedSum: number; refusedCount: number;      // отказы ПЕРИОДА
  cutoffSum: number; cutoffCount: number;         // открытые сделки за отсечкой группы (снимок сейчас)
  noCallBookingsSum: number; noCallBookingsCount: number; // активные брони без звонка (снимок сейчас)
  total: number;
}

interface BookingNoCallRow { deal_id: number; amount: string | null }

async function computeMissed(managerIdNum: number, fromIso: string, toExclIso: string, openDeals: OpenDealRow[]): Promise<MissedBreakdown> {
  const refusedRes = await analyticsDb().query<{ cnt: string; sum: string | null }>(
    `SELECT count(*) AS cnt, COALESCE(sum(amount), 0) AS sum FROM sa.deals
     WHERE current_manager_id = $1 AND lost_at >= $2 AND lost_at < $3`,
    [managerIdNum, fromIso, toExclIso],
  );
  const refusedCount = Number(refusedRes.rows[0]?.cnt ?? 0);
  const refusedSum = Number(refusedRes.rows[0]?.sum ?? 0);

  // За отсечкой своей группы — снимок ТЕКУЩИХ открытых первичных сделок (движок cutoffs,
  // те же ставки, что «Разгрузка отделов»); повторка отсечкам не подчиняется (как в offload).
  let cutoffSum = 0, cutoffCount = 0;
  for (const d of openDeals) {
    if (d.is_repeat) continue;
    const workDays = Number(d.work_days ?? 0);
    if (workDays > cutoffForHeadGroup(d.head_group)) {
      cutoffSum += Number(d.amount ?? 0); cutoffCount++;
    }
  }

  // Активные брони (reserved, ещё не проданы/не отказ) без единого звонка — снимок сейчас.
  const bookingsRes = await analyticsDb().query<BookingNoCallRow>(
    `SELECT deal_id, amount FROM sa.deals
     WHERE current_manager_id = $1 AND reserved_at IS NOT NULL AND sold_at IS NULL AND lost_at IS NULL`,
    [managerIdNum],
  );
  let noCallBookingsSum = 0, noCallBookingsCount = 0;
  if (bookingsRes.rows.length > 0) {
    const ids = bookingsRes.rows.map(r => r.deal_id);
    const calls = await analyticsDb().query<{ deal_id: string }>(
      `SELECT DISTINCT deal_id FROM va.calls WHERE deal_id = ANY($1)`, [ids],
    );
    const called = new Set(calls.rows.map(r => String(r.deal_id)));
    for (const b of bookingsRes.rows) {
      if (!called.has(String(b.deal_id))) { noCallBookingsSum += Number(b.amount ?? 0); noCallBookingsCount++; }
    }
  }

  return {
    refusedSum, refusedCount, cutoffSum, cutoffCount, noCallBookingsSum, noCallBookingsCount,
    total: refusedSum + cutoffSum + noCallBookingsSum,
  };
}

// ── Блок 4: акцент броней (со звонком / без звонка) ──────────────────────────

export interface BookingCallStat { total: number; withCall: number; withoutCall: number; withCallPct: number | null }

async function computeBookingCallStat(managerIdNum: number): Promise<BookingCallStat> {
  const res = await analyticsDb().query<{ deal_id: number }>(
    `SELECT deal_id FROM sa.deals
     WHERE current_manager_id = $1 AND reserved_at IS NOT NULL AND sold_at IS NULL AND lost_at IS NULL`,
    [managerIdNum],
  );
  const total = res.rows.length;
  if (total === 0) return { total: 0, withCall: 0, withoutCall: 0, withCallPct: null };
  const ids = res.rows.map(r => r.deal_id);
  const calls = await analyticsDb().query<{ deal_id: string }>(
    `SELECT DISTINCT deal_id FROM va.calls WHERE deal_id = ANY($1)`, [ids],
  );
  const withCall = new Set(calls.rows.map(r => String(r.deal_id))).size;
  return { total, withCall, withoutCall: total - withCall, withCallPct: (withCall / total) * 100 };
}

// ── Сводка «где деньги» — топ-3 действия по деньгам ──────────────────────────

export interface MoneyAction { key: string; label: string; amount: number; count: number }

function buildMoneyActions(missed: MissedBreakdown, customers: CustomerRow[], catSettings: Awaited<ReturnType<typeof fetchCategorySettings>>): MoneyAction[] {
  const actions: MoneyAction[] = [];
  if (missed.noCallBookingsCount > 0) {
    actions.push({ key: 'no_call_bookings', label: `Брони без звонка: ${missed.noCallBookingsCount} шт`, amount: missed.noCallBookingsSum, count: missed.noCallBookingsCount });
  }
  const keyAtRisk = customers.filter(c => {
    if (classifyCategory(c, catSettings).category !== 'key') return false;
    if (c.activeCount > 0 || c.lastSoldAt === null) return false;
    const since = (Date.now() - new Date(c.lastSoldAt).getTime()) / 86_400_000;
    return since > 2 * c.cycleDays;
  });
  if (keyAtRisk.length > 0) {
    actions.push({
      key: 'key_at_risk', label: `Ключевые клиенты под угрозой: ${keyAtRisk.length} шт`,
      amount: keyAtRisk.reduce((s, c) => s + c.sumSold, 0), count: keyAtRisk.length,
    });
  }
  const callNow = customers.filter(c => c.signals.length > 0);
  if (callNow.length > 0) {
    actions.push({
      key: 'call_now', label: `Пора позвонить: ${callNow.length} клиентов`,
      amount: callNow.reduce((s, c) => s + c.sumSold, 0), count: callNow.length,
    });
  }
  actions.sort((a, b) => b.amount - a.amount);
  return actions.slice(0, 3);
}

// ── Верхнеуровневая сборка (менеджер) ────────────────────────────────────────

export interface PlanyorkaResult {
  unit: PlanyorkaUnit;
  period: { fromStr: string; toStr: string };
  compare: { fromStr: string; toStr: string };
  totals: PeriodTotals; prevTotals: PeriodTotals;
  groupDeltas: { rising: GroupDelta[]; falling: GroupDelta[] };
  potential: PotentialBreakdown;
  missed: MissedBreakdown;
  bookingCallStat: BookingCallStat;
  moneyActions: MoneyAction[];
  plan: { planSales: number | null; salesAmount: number; toGoal: number | null };
}

function pct(a: number, b: number): number | null { return b > 0 ? ((a - b) / b) * 100 : null; }
// МСК-локальная календарная дата (НЕ .toISOString() — тот отдаёт UTC-дату и на
// сервере с TZ=Europe/Moscow сдвигал бы полночь МСК на день назад, баг пойман
// живьём при проверке: period.fromStr показывал 31.07 вместо 01.08 для месяца
// offset=0). Тот же приём, что mskToday() в features/badges/engine/compute.ts.
function ymd(d: Date): string { return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }); }

export async function buildManagerPlanyorka(managerBitrixId: number, unit: PlanyorkaUnit, offset: number): Promise<PlanyorkaResult> {
  const { period, compare } = periodBounds(unit, offset);
  const { from: periodFrom, toExcl: periodToExcl } = toSqlInterval(period);
  const { from: compareFrom, toExcl: compareToExcl } = toSqlInterval(compare);

  const [model, totals, prevTotals, groupNow, groupPrev, customers, catSettings, openDeals] = await Promise.all([
    getOffloadModel(),
    fetchTotals([managerBitrixId], periodFrom, periodToExcl),
    fetchTotals([managerBitrixId], compareFrom, compareToExcl),
    fetchGroupSales([managerBitrixId], periodFrom, periodToExcl),
    fetchGroupSales([managerBitrixId], compareFrom, compareToExcl),
    fetchManagerCustomers(managerBitrixId),
    fetchCategorySettings(),
    fetchOpenDealsForManager(managerBitrixId),
  ]);

  const groups = new Set([...groupNow.keys(), ...groupPrev.keys()]);
  const deltas: GroupDelta[] = [...groups].map(g => {
    const amount = groupNow.get(g) ?? 0; const prevAmount = groupPrev.get(g) ?? 0;
    return { group: g, amount, prevAmount, delta: amount - prevAmount, deltaPct: pct(amount, prevAmount) };
  });
  const rising = deltas.filter(d => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 3);
  const falling = deltas.filter(d => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3);

  const potential = await computePotential(managerBitrixId, model, customers);
  const missed = await computeMissed(managerBitrixId, periodFrom, periodToExcl, openDeals);
  const bookingCallStat = await computeBookingCallStat(managerBitrixId);
  const moneyActions = buildMoneyActions(missed, customers, catSettings);

  // План — по логину менеджера (manager_plans, та же таблица, что план/факт-полоса).
  const loginRes = await analyticsDb().query<{ short_login: string }>(
    `SELECT short_login FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id = $1 AND short_login IS NOT NULL LIMIT 1`,
    [String(managerBitrixId)],
  );
  const login = loginRes.rows[0]?.short_login ?? null;
  let planSales: number | null = null;
  if (login && unit === 'month') {
    const todayStr = ymd(new Date());
    const { byLogin } = await computePeriodPlanByLogin(ymd(period.from), ymd(period.to), todayStr);
    planSales = byLogin.get(login)?.planSales ?? null;
  }
  const toGoal = planSales !== null ? Math.max(0, planSales - totals.salesAmount) : null;

  return {
    unit,
    period: { fromStr: ymd(period.from), toStr: ymd(period.to) },
    compare: { fromStr: ymd(compare.from), toStr: ymd(compare.to) },
    totals, prevTotals, groupDeltas: { rising, falling },
    potential, missed, bookingCallStat, moneyActions,
    plan: { planSales, salesAmount: totals.salesAmount, toGoal },
  };
}

// ── РОП: агрегат команды ──────────────────────────────────────────────────────

export interface TeamPlanyorkaRow {
  bitrixId: number; name: string;
  salesAmount: number; salesDeltaPct: number | null;
  noCallBookingsCount: number; noCallBookingsSum: number;
  potentialMid: number; missedTotal: number;
  keyAtRiskCount: number;
}

export async function buildTeamPlanyorka(managers: { id: number; name: string }[], unit: PlanyorkaUnit, offset: number): Promise<TeamPlanyorkaRow[]> {
  const out: TeamPlanyorkaRow[] = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < managers.length; i += CONCURRENCY) {
    const chunk = managers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async m => {
      const r = await buildManagerPlanyorka(m.id, unit, offset);
      const keyAtRisk = r.moneyActions.find(a => a.key === 'key_at_risk')?.count ?? 0;
      return {
        bitrixId: m.id, name: m.name,
        salesAmount: r.totals.salesAmount, salesDeltaPct: pct(r.totals.salesAmount, r.prevTotals.salesAmount),
        noCallBookingsCount: r.missed.noCallBookingsCount, noCallBookingsSum: r.missed.noCallBookingsSum,
        potentialMid: r.potential.totalMid, missedTotal: r.missed.total,
        keyAtRiskCount: keyAtRisk,
      };
    }));
    out.push(...results);
  }
  return out;
}
