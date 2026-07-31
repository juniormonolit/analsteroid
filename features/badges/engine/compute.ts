// Движок начисления бейджей (задача 2655, этап 1).
//
// Принципы:
//  * Полный идемпотентный пересчёт с RETRO_START при каждом запуске: badge_awards
//    имеет UNIQUE (bitrix_id, badge_key, tier, period_type, period_date) — повторный
//    прогон без новых данных даёт 0 вставок. Счётчиковые бейджи (кросс-селл, вехи)
//    обновляют value через ON CONFLICT DO UPDATE (строка одна, растёт только счётчик).
//  * Периодические топы начисляются ТОЛЬКО за ЗАВЕРШЁННЫЕ периоды (день < сегодня,
//    неделя/месяц/год закончились) — иначе «лучший за период» менялся бы задним числом.
//  * Данные — sa.deals (analyticsDb, read-only), награды — системная БД (systemDb).
//  * Уровень топа = масштаб победы: отдел=бронза, департамент=серебро, филиал=золото,
//    страна=платина; менеджеру пишется ТОЛЬКО высший достигнутый уровень периода.

import type { PoolClient } from 'pg';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { isWorkingDayJs } from '@/lib/metrics/productionCalendar';
import { cutoffForHeadGroup } from '@/features/offload/engine/cutoffs';
import { BADGE_CATALOG, CROSS_SELL_PAIRS, type BadgeTier } from './catalog';
import { getManagerScopes, type ManagerScope } from './orgScopes';
import { accrueCoins } from './coins';
import { runWalletTick } from './wallet';
import { CUSTOM_PREFIX, validateCustomCriteria, type CustomCriteria, type CustomMetric, type CustomPeriod } from './customTemplates';

export const RETRO_START = '2026-04-03'; // решение владельца: ретро с 03.04.2026

const MSK = 'Europe/Moscow';

interface AwardRow {
  bitrixId: number;
  badgeKey: string;
  tier: BadgeTier | null;
  periodType: 'day' | 'week' | 'month' | 'year' | null;
  periodDate: string | null; // YYYY-MM-DD (начало периода / день события)
  value: number | null;
  counter?: boolean; // true → ON CONFLICT DO UPDATE value (счётчиковые бейджи)
}

export interface RecomputeStats {
  inserted: number;
  updated: number;
  total: number;
  byBadge: Record<string, number>; // вставлено новых за прогон
  // Валюта (задача 2657): начислено транзакций / сумма эмиссии этим прогоном.
  coinsAccrued: number;
  coinsEmitted: number;
  // Кошелёк (задача 31.07): сгорание TTL и истечение предметов инвентаря.
  expiredLedger: number;
  expiredAmount: number;
  expiredItems: number;
  refundedAmount: number;
  ms: number;
}

// ── календарные помощники (все даты — строки YYYY-MM-DD в МСК) ───────────────

function mskToday(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: MSK });
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoDow(iso: string): number { // 1=Пн … 7=Вс
  const d = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function weekStart(iso: string): string { return addDays(iso, 1 - isoDow(iso)); }
function monthStart(iso: string): string { return `${iso.slice(0, 7)}-01`; }
function yearStart(iso: string): string { return `${iso.slice(0, 4)}-01-01`; }

function isWorkDay(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number);
  return isWorkingDayJs(y, m, d, isoDow(iso));
}

// ── загрузка каталога/настроек ───────────────────────────────────────────────

async function seedDefinitions(client: PoolClient): Promise<void> {
  for (const b of BADGE_CATALOG) {
    await client.query(
      `INSERT INTO badge_definitions (key, name, description, icon, category, tiered, criteria, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (key) DO NOTHING`,
      [b.key, b.name, b.description, b.icon, b.category, b.tiered, JSON.stringify(b.criteria), b.sortOrder],
    );
  }
}

interface DefRow { key: string; enabled: boolean; criteria: Record<string, unknown> }

async function loadDefs(client: PoolClient): Promise<Map<string, DefRow>> {
  const res = await client.query<DefRow>(`SELECT key, enabled, criteria FROM badge_definitions`);
  return new Map(res.rows.map(r => [r.key, r]));
}

function num(criteria: Record<string, unknown> | undefined, key: string, dflt: number): number {
  const v = criteria?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

// ── данные из sa.deals ───────────────────────────────────────────────────────

interface DaySum { managerId: number; day: string; amount: number; cnt: number }

async function fetchDaySums(kind: 'sales' | 'shipments' | 'repeat_sales' | 'bookings'): Promise<DaySum[]> {
  // bookings — события броней (reserved_at) для «Ежедневного бонуса» (доп. Серёги 31.07)
  const dateField = kind === 'shipments' ? 'delivered_at' : kind === 'bookings' ? 'reserved_at' : 'sold_at';
  const repeatJoin = kind === 'repeat_sales'
    ? 'JOIN sa.funnels f ON f.id = d.funnel_id AND f.is_repeat = true' : '';
  const res = await analyticsDb().query<{ manager_id: number; day: string; amount: string; cnt: string }>(
    `SELECT d.current_manager_id AS manager_id,
            (d.${dateField} AT TIME ZONE '${MSK}')::date::text AS day,
            sum(coalesce(d.amount, 0)) AS amount,
            count(*) AS cnt
       FROM sa.deals d ${repeatJoin}
      WHERE d.${dateField} IS NOT NULL AND d.current_manager_id IS NOT NULL
      GROUP BY 1, 2`,
  );
  return res.rows.map(r => ({ managerId: r.manager_id, day: r.day, amount: Number(r.amount), cnt: Number(r.cnt) }));
}

// ── периодические топы ───────────────────────────────────────────────────────

function periodsOf(day: string): { type: AwardRow['periodType']; start: string }[] {
  return [
    { type: 'day', start: day },
    { type: 'week', start: weekStart(day) },
    { type: 'month', start: monthStart(day) },
    { type: 'year', start: yearStart(day) },
  ];
}

function periodEnded(type: string, start: string, today: string): boolean {
  if (type === 'day') return start < today;
  if (type === 'week') return addDays(start, 7) <= today;
  if (type === 'month') {
    const [y, m] = start.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    return next <= today;
  }
  const y = Number(start.slice(0, 4));
  return `${y + 1}-01-01` <= today;
}

// opts (этап 2, конструктор): кастомный «Топ по метрике» ограничивает типы
// периодов одним выбранным и может быть одноуровневым (tiered=false — лучший по
// стране, tier=null). Пресеты этапа 1 зовут без opts — поведение прежнее.
interface TopOpts {
  periodTypes?: ReadonlySet<string>;
  tiered?: boolean;                  // default true
  value?: (s: DaySum) => number;     // default amount
}

function computeTopAwards(
  badgeKey: string,
  daySums: DaySum[],
  scopes: Map<number, ManagerScope>,
  minAmount: number,
  today: string,
  opts?: TopOpts,
): AwardRow[] {
  const value = opts?.value ?? ((s: DaySum) => s.amount);
  // Суммы по (менеджер, период)
  const byPeriod = new Map<string, Map<number, number>>(); // `${type}:${start}` -> mgr -> sum
  for (const s of daySums) {
    if (s.day < RETRO_START.slice(0, 4) + '-01-01') continue; // не раньше года ретро
    for (const p of periodsOf(s.day)) {
      if (opts?.periodTypes && !opts.periodTypes.has(p.type!)) continue;
      if (!periodEnded(p.type!, p.start, today)) continue;
      const key = `${p.type}:${p.start}`;
      let m = byPeriod.get(key);
      if (!m) { m = new Map(); byPeriod.set(key, m); }
      m.set(s.managerId, (m.get(s.managerId) ?? 0) + value(s));
    }
  }

  const awards: AwardRow[] = [];
  for (const [key, sums] of byPeriod) {
    const [type, start] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    // День/неделя раньше ретро-старта не начисляем (месяц/год — если пересекаются с ретро-окном)
    if ((type === 'day' || type === 'week') && start < RETRO_START) continue;
    // Победители по масштабам
    const best = (group: (s: ManagerScope | undefined) => string | null): Map<string, { max: number; winners: number[] }> => {
      const acc = new Map<string, { max: number; winners: number[] }>();
      for (const [mgr, sum] of sums) {
        if (sum < minAmount) continue;
        const g = group(scopes.get(mgr));
        if (g === null) continue;
        const cur = acc.get(g);
        if (!cur || sum > cur.max) acc.set(g, { max: sum, winners: [mgr] });
        else if (sum === cur.max) cur.winners.push(mgr);
      }
      return acc;
    };
    // Одноуровневый кастомный топ: только победитель по всей стране, tier=null.
    if (opts?.tiered === false) {
      for (const { max, winners } of best(() => 'all').values()) {
        for (const mgr of winners) {
          awards.push({
            bitrixId: mgr, badgeKey, tier: null,
            periodType: type as AwardRow['periodType'], periodDate: start, value: max,
          });
        }
      }
      continue;
    }
    const tiers: [BadgeTier, Map<string, { max: number; winners: number[] }>][] = [
      ['bronze', best(s => s?.deptKey ?? null)],
      ['silver', best(s => s?.parentKey ?? null)],
      ['gold', best(s => s?.branchKey ?? null)],
      ['platinum', best(() => 'all')],
    ];
    // высший достигнутый уровень на менеджера
    const topTier = new Map<number, { tier: BadgeTier; value: number }>();
    for (const [tier, acc] of tiers) {
      for (const { max, winners } of acc.values()) {
        for (const mgr of winners) topTier.set(mgr, { tier, value: max }); // порядок массива = от бронзы к платине
      }
    }
    for (const [mgr, t] of topTier) {
      awards.push({
        bitrixId: mgr, badgeKey, tier: t.tier,
        periodType: type as AwardRow['periodType'], periodDate: start, value: t.value,
      });
    }
  }
  return awards;
}

// ── кросс-селл ───────────────────────────────────────────────────────────────

interface Transition { managerId: number; soldAt: string; prevGroups: string[]; nextGroups: string[] }

async function fetchCrossSellTransitions(): Promise<Transition[]> {
  // Оконный LEAD по клиенту (решение из брифа — вместо таймаутящего LATERAL):
  // товарные head-группы позиций сделки, услуги/доставка/«Разное» исключены.
  const res = await analyticsDb().query<{ manager_id: number; sold_at: string; prev_grps: string[]; next_grps: string[] }>(
    `WITH dg AS (
       SELECT d.contact_id, d.deal_id, d.sold_at, d.current_manager_id,
              array(SELECT DISTINCT (p->>'head_group_name') FROM jsonb_array_elements(d.products) p
                    WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
                      AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)') AS grps
       FROM sa.deals d
       WHERE d.sold_at IS NOT NULL AND d.contact_id IS NOT NULL
     ), seq AS (
       SELECT contact_id, grps AS prev_grps, current_manager_id, sold_at,
              LEAD(grps) OVER w AS next_grps,
              LEAD(current_manager_id) OVER w AS next_manager,
              LEAD(sold_at) OVER w AS next_sold_at
       FROM dg
       WINDOW w AS (PARTITION BY contact_id ORDER BY sold_at, deal_id)
     )
     SELECT next_manager AS manager_id,
            (next_sold_at AT TIME ZONE '${MSK}')::date::text AS sold_at,
            prev_grps, next_grps
       FROM seq
      WHERE next_grps IS NOT NULL AND next_manager IS NOT NULL
        AND next_sold_at >= $1::date`,
    [RETRO_START],
  );
  return res.rows.map(r => ({
    managerId: r.manager_id, soldAt: r.sold_at,
    prevGroups: r.prev_grps ?? [], nextGroups: r.next_grps ?? [],
  }));
}

// ── повторные/скорость/рекорды/вехи: агрегаты по сделкам ─────────────────────

interface SoldDealRow {
  dealId: number; managerId: number; contactId: number | null;
  createdDay: string | null; soldDay: string; amount: number; rn: number; // rn по контакту
}

async function fetchSoldDeals(): Promise<SoldDealRow[]> {
  const res = await analyticsDb().query<{
    deal_id: number; manager_id: number; contact_id: number | null;
    created_day: string | null; sold_day: string; amount: string; rn: string;
  }>(
    `SELECT d.deal_id, d.current_manager_id AS manager_id, d.contact_id,
            (d.created_at AT TIME ZONE '${MSK}')::date::text AS created_day,
            (d.sold_at AT TIME ZONE '${MSK}')::date::text AS sold_day,
            coalesce(d.amount, 0) AS amount,
            row_number() OVER (PARTITION BY d.contact_id ORDER BY d.sold_at, d.deal_id) AS rn
       FROM sa.deals d
      WHERE d.sold_at IS NOT NULL AND d.current_manager_id IS NOT NULL
      ORDER BY d.sold_at`,
  );
  return res.rows.map(r => ({
    dealId: r.deal_id, managerId: r.manager_id, contactId: r.contact_id,
    createdDay: r.created_day, soldDay: r.sold_day, amount: Number(r.amount), rn: Number(r.rn),
  }));
}

// ── гигиена: открытые за отсечкой на конец недели ────────────────────────────

interface OpenDealRow {
  managerId: number; createdDay: string; closedDay: string | null; headGroup: string | null;
}

async function fetchDealLifecycles(): Promise<OpenDealRow[]> {
  const res = await analyticsDb().query<{ manager_id: number; created_day: string; closed_day: string | null; head_group: string | null }>(
    `SELECT d.current_manager_id AS manager_id,
            (d.created_at AT TIME ZONE '${MSK}')::date::text AS created_day,
            (LEAST(d.sold_at, d.delivered_at, d.lost_at) AT TIME ZONE '${MSK}')::date::text AS closed_day,
            d.head_group_name AS head_group
       FROM sa.deals d
      WHERE d.current_manager_id IS NOT NULL AND d.created_at IS NOT NULL
        AND d.created_at >= '2025-06-01'`,
  );
  return res.rows.map(r => ({
    managerId: r.manager_id, createdDay: r.created_day, closedDay: r.closed_day, headGroup: r.head_group,
  }));
}

// Префикс-суммы рабочих дней производственного календаря: workIdx[d] = сколько
// рабочих дней от CAL_START до d включительно. Отсечки — аппроксимация
// «календарных рабочих дней с создания» (движок offload меряет рабочие дни
// В WORK-стадиях; ретро-истории стадий по неделям нет — осознанное упрощение).
const CAL_START = '2025-06-01';
let _workIdx: Map<string, number> | null = null;

function workIdx(): Map<string, number> {
  if (_workIdx) return _workIdx;
  const map = new Map<string, number>();
  let n = 0;
  const end = addDays(mskToday(), 366);
  for (let d = CAL_START; d <= end; d = addDays(d, 1)) {
    if (isWorkDay(d)) n++;
    map.set(d, n);
  }
  _workIdx = map;
  return map;
}

function workDaysBetween(fromIso: string, toIso: string): number {
  const idx = workIdx();
  const a = idx.get(fromIso < CAL_START ? CAL_START : fromIso) ?? 0;
  const b = idx.get(toIso) ?? 0;
  return Math.max(0, b - a);
}

// ── кастомные награды (этап 2, конструктор): generic-исполнители шаблонов ────

interface CustomCtx {
  today: string;
  scopes: Map<number, ManagerScope>;
  sold: SoldDealRow[];
  transitions: Transition[];
  metricSums: Record<CustomMetric, DaySum[]>;
  bookingDaySums: DaySum[]; // события reserved_at — для «Ежедневного бонуса»
}

const metricValue = (metric: CustomMetric) =>
  metric === 'sales_count' || metric === 'repeat_sales_count'
    ? (s: DaySum) => s.cnt
    : (s: DaySum) => s.amount;

function periodStartOf(period: CustomPeriod, day: string): string {
  if (period === 'day') return day;
  if (period === 'week') return weekStart(day);
  if (period === 'month') return monthStart(day);
  return yearStart(day);
}

function computeCustomBadge(key: string, c: CustomCriteria, ctx: CustomCtx): AwardRow[] {
  const awards: AwardRow[] = [];
  switch (c.template) {
    // 1. «Топ по метрике за период» — тот же computeTopAwards, что у пресетов,
    //    но с одним типом периода и опциональной одноуровневостью.
    case 'top_metric': {
      awards.push(...computeTopAwards(key, ctx.metricSums[c.metric!], ctx.scopes, 1, ctx.today, {
        periodTypes: new Set([c.period!]),
        tiered: c.tieredScopes === true,
        value: metricValue(c.metric!),
      }));
      break;
    }

    // 2. «Порог за период»: метрика за завершённый период >= threshold —
    //    отдельная награда за каждый такой период (те же ретро-границы, что у топов).
    case 'threshold_period': {
      const value = metricValue(c.metric!);
      const yearFloor = RETRO_START.slice(0, 4) + '-01-01';
      const byPeriod = new Map<string, number>(); // `${mgr}:${start}` -> value
      for (const s of ctx.metricSums[c.metric!]) {
        if (s.day < yearFloor) continue;
        const start = periodStartOf(c.period!, s.day);
        if ((c.period === 'day' || c.period === 'week') && start < RETRO_START) continue;
        if (!periodEnded(c.period!, start, ctx.today)) continue;
        const k = `${s.managerId}:${start}`;
        byPeriod.set(k, (byPeriod.get(k) ?? 0) + value(s));
      }
      for (const [k, sum] of byPeriod) {
        if (sum < c.threshold!) continue;
        const [mgr, start] = [Number(k.slice(0, k.indexOf(':'))), k.slice(k.indexOf(':') + 1)];
        awards.push({ bitrixId: mgr, badgeKey: key, tier: null, periodType: c.period!, periodDate: start, value: sum });
      }
      break;
    }

    // 3. «Кросс-селл пара»: как пресетные связки (тот же поток transitions),
    //    но группы и минимум пар — параметры создателя.
    case 'crosssell_pair': {
      const counts = new Map<number, number>();
      for (const t of ctx.transitions) {
        if (t.prevGroups.includes(c.firstGroup!) && t.nextGroups.includes(c.nextGroup!)) {
          counts.set(t.managerId, (counts.get(t.managerId) ?? 0) + 1);
        }
      }
      for (const [mgr, count] of counts) {
        if (count < c.minPairs!) continue;
        awards.push({ bitrixId: mgr, badgeKey: key, tier: null, periodType: null, periodDate: null, value: count, counter: true });
      }
      break;
    }

    // 4. «Серия»: N рабочих дней подряд с продажей — логика пресетов streak_5/10.
    case 'streak': {
      const len = c.days!;
      const saleDaysByMgr = new Map<number, Set<string>>();
      for (const s of ctx.metricSums.sales_amount) {
        if (s.amount <= 0) continue;
        (saleDaysByMgr.get(s.managerId) ?? saleDaysByMgr.set(s.managerId, new Set()).get(s.managerId)!).add(s.day);
      }
      for (const [mgr, saleDays] of saleDaysByMgr) {
        let run = 0;
        for (let d = RETRO_START; d < ctx.today; d = addDays(d, 1)) {
          if (!isWorkDay(d)) continue; // выходные серию не рвут и не продлевают
          if (saleDays.has(d)) {
            run++;
            if (run === len) {
              awards.push({ bitrixId: mgr, badgeKey: key, tier: null, periodType: 'day', periodDate: d, value: len });
            }
          } else run = 0;
        }
      }
      break;
    }

    // 6. «Ежедневный бонус» (доп. Серёги 31.07): автопоощрение валютой за каждый
    //    день, где метрика дня >= порога. Награда per (менеджер, день) — уникальность
    //    uq_badge_awards, идемпотентно; сумма начисления = цена определения в
    //    badge_prices ('-'), начисляет общий accrueCoins (source='auto').
    //    criteria.silent=true → полка бейдж не показывает (только выписка и баланс).
    case 'daily_bonus': {
      const metric = c.dailyMetric!;
      const per = new Map<string, number>(); // `${mgr}:${day}` -> значение метрики
      const add = (sums: DaySum[], v: (s: DaySum) => number) => {
        for (const s of sums) {
          if (s.day < RETRO_START || s.day >= ctx.today) continue; // только завершённые дни ретро-окна
          const k = `${s.managerId}:${s.day}`;
          per.set(k, (per.get(k) ?? 0) + v(s));
        }
      };
      if (metric === 'sales_count') add(ctx.metricSums.sales_amount, s => s.cnt);
      else if (metric === 'sales_amount') add(ctx.metricSums.sales_amount, s => s.amount);
      else if (metric === 'shipments_count') add(ctx.metricSums.shipments_amount, s => s.cnt);
      else if (metric === 'shipments_amount') add(ctx.metricSums.shipments_amount, s => s.amount);
      else if (metric === 'bookings_count') add(ctx.bookingDaySums, s => s.cnt);
      else { // bookings_plus_sales_count — составная: брони + продажи событий дня
        add(ctx.bookingDaySums, s => s.cnt);
        add(ctx.metricSums.sales_amount, s => s.cnt);
      }
      for (const [k, val] of per) {
        if (val < c.threshold!) continue;
        const [mgr, day] = [Number(k.slice(0, k.indexOf(':'))), k.slice(k.indexOf(':') + 1)];
        awards.push({ bitrixId: mgr, badgeKey: key, tier: null, periodType: 'day', periodDate: day, value: val });
      }
      break;
    }

    // 5. «Веха»: накопительный порог за всё время (как sales_100/big_deal).
    case 'milestone': {
      const totals = new Map<number, number>(); // счётчик/сумма/кол-во крупных чеков
      for (const d of ctx.sold) {
        if (c.kind === 'sales_count') totals.set(d.managerId, (totals.get(d.managerId) ?? 0) + 1);
        else if (c.kind === 'sales_amount') totals.set(d.managerId, (totals.get(d.managerId) ?? 0) + d.amount);
        else if (d.amount >= c.threshold! && d.soldDay >= RETRO_START) {
          // deal_amount: чеки с ретро-старта, как у пресета big_deal
          totals.set(d.managerId, (totals.get(d.managerId) ?? 0) + 1);
        }
      }
      for (const [mgr, total] of totals) {
        if (c.kind !== 'deal_amount' && total < c.threshold!) continue;
        awards.push({ bitrixId: mgr, badgeKey: key, tier: null, periodType: null, periodDate: null, value: total, counter: true });
      }
      break;
    }
  }
  return awards;
}

// ── основной пересчёт ────────────────────────────────────────────────────────

export async function runBadgeRecompute(): Promise<RecomputeStats> {
  const t0 = Date.now();
  const today = mskToday();
  const client = await systemDb().connect();
  try {
    await seedDefinitions(client);
    const defs = await loadDefs(client);
    const enabled = (key: string) => defs.get(key)?.enabled !== false;
    const crit = (key: string) => defs.get(key)?.criteria ?? {};

    const scopes = await getManagerScopes();
    const awards: AwardRow[] = [];

    // 1. Периодические топы
    const topSpecs: { key: string; kind: 'sales' | 'shipments' | 'repeat_sales' }[] = [
      { key: 'top_sales', kind: 'sales' },
      { key: 'top_shipments', kind: 'shipments' },
      { key: 'top_repeat_sales', kind: 'repeat_sales' },
    ];
    let salesDaySums: DaySum[] = [];
    let shipmentDaySums: DaySum[] = [];
    let repeatDaySums: DaySum[] = [];
    for (const spec of topSpecs) {
      const sums = await fetchDaySums(spec.kind);
      if (spec.kind === 'sales') salesDaySums = sums;
      if (spec.kind === 'shipments') shipmentDaySums = sums;
      if (spec.kind === 'repeat_sales') repeatDaySums = sums;
      if (!enabled(spec.key)) continue;
      awards.push(...computeTopAwards(spec.key, sums, scopes, num(crit(spec.key), 'minAmount', 1), today));
    }

    // 2. Кросс-селл пары + «Мастер комбо»
    const transitions = await fetchCrossSellTransitions();
    const pairKeysByMgr = new Map<number, Set<string>>();
    {
      const counts = new Map<string, number>(); // `${mgr}:${pairKey}`
      for (const t of transitions) {
        const prev = new Set(t.prevGroups);
        const next = new Set(t.nextGroups);
        for (const pair of CROSS_SELL_PAIRS) {
          const def = defs.get(pair.key);
          const first = (def?.criteria?.firstGroup as string) ?? pair.first;
          const nxt = (def?.criteria?.nextGroup as string) ?? pair.next;
          if (prev.has(first) && next.has(nxt)) {
            const k = `${t.managerId}:${pair.key}`;
            counts.set(k, (counts.get(k) ?? 0) + 1);
            let set = pairKeysByMgr.get(t.managerId);
            if (!set) { set = new Set(); pairKeysByMgr.set(t.managerId, set); }
            set.add(pair.key);
          }
        }
      }
      for (const [k, count] of counts) {
        const [mgr, pairKey] = [Number(k.slice(0, k.indexOf(':'))), k.slice(k.indexOf(':') + 1)];
        if (!enabled(pairKey)) continue;
        awards.push({ bitrixId: mgr, badgeKey: pairKey, tier: null, periodType: null, periodDate: null, value: count, counter: true });
      }
      if (enabled('combo_master')) {
        const minPairs = num(crit('combo_master'), 'minPairs', 5);
        for (const [mgr, set] of pairKeysByMgr) {
          if (set.size >= minPairs) {
            awards.push({ bitrixId: mgr, badgeKey: 'combo_master', tier: null, periodType: null, periodDate: null, value: set.size, counter: true });
          }
        }
      }
    }

    // 3. Повторные, скорость, рекорды, вехи, стрики — на одном скане проданных сделок
    const sold = await fetchSoldDeals();

    // «Универсал»: различные товарные head-группы в проданном (по позициям)
    if (enabled('universal')) {
      const res = await analyticsDb().query<{ manager_id: number; groups: string }>(
        `SELECT d.current_manager_id AS manager_id,
                count(DISTINCT p->>'head_group_name') AS groups
           FROM sa.deals d, jsonb_array_elements(d.products) p
          WHERE d.sold_at IS NOT NULL AND d.current_manager_id IS NOT NULL
            AND coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
            AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)'
          GROUP BY 1`,
      );
      const minGroups = num(crit('universal'), 'minGroups', 10);
      for (const r of res.rows) {
        if (Number(r.groups) >= minGroups) {
          awards.push({ bitrixId: r.manager_id, badgeKey: 'universal', tier: null, periodType: null, periodDate: null, value: Number(r.groups), counter: true });
        }
      }
    }

    // «Вернул клиента» / «Постоянник»
    if (enabled('return_client') || enabled('loyal_client')) {
      const returned = new Map<number, number>();          // mgr -> клиентов вернул (rn=2, с ретро-старта)
      const repeatsByMgrContact = new Map<string, number>(); // `${mgr}:${contact}` -> повторные продажи
      for (const d of sold) {
        if (d.contactId === null) continue;
        if (d.rn === 2 && d.soldDay >= RETRO_START) returned.set(d.managerId, (returned.get(d.managerId) ?? 0) + 1);
        if (d.rn >= 2) {
          const k = `${d.managerId}:${d.contactId}`;
          repeatsByMgrContact.set(k, (repeatsByMgrContact.get(k) ?? 0) + 1);
        }
      }
      if (enabled('return_client')) {
        for (const [mgr, count] of returned) {
          awards.push({ bitrixId: mgr, badgeKey: 'return_client', tier: null, periodType: null, periodDate: null, value: count, counter: true });
        }
      }
      if (enabled('loyal_client')) {
        const minRepeats = num(crit('loyal_client'), 'minRepeats', 3);
        const loyal = new Map<number, number>();
        for (const [k, n] of repeatsByMgrContact) {
          if (n >= minRepeats) {
            const mgr = Number(k.slice(0, k.indexOf(':')));
            loyal.set(mgr, (loyal.get(mgr) ?? 0) + 1);
          }
        }
        for (const [mgr, count] of loyal) {
          awards.push({ bitrixId: mgr, badgeKey: 'loyal_client', tier: null, periodType: null, periodDate: null, value: count, counter: true });
        }
      }
    }

    // «Продал день в день»
    if (enabled('same_day_sale')) {
      const cnt = new Map<number, number>();
      for (const d of sold) {
        if (d.soldDay >= RETRO_START && d.createdDay === d.soldDay) cnt.set(d.managerId, (cnt.get(d.managerId) ?? 0) + 1);
      }
      for (const [mgr, count] of cnt) {
        awards.push({ bitrixId: mgr, badgeKey: 'same_day_sale', tier: null, periodType: null, periodDate: null, value: count, counter: true });
      }
    }

    // «Быстрее медианы группы» (месяц, отдел)
    if (enabled('faster_than_median')) {
      const minDeals = num(crit('faster_than_median'), 'minDeals', 3);
      const byMonthMgr = new Map<string, number[]>(); // `${month}:${mgr}` -> дни до продажи
      for (const d of sold) {
        if (d.soldDay < RETRO_START || d.createdDay === null) continue;
        const month = monthStart(d.soldDay);
        if (!periodEnded('month', month, today)) continue;
        const days = Math.max(0, Math.round((Date.parse(d.soldDay) - Date.parse(d.createdDay)) / 86400000));
        const k = `${month}:${d.managerId}`;
        (byMonthMgr.get(k) ?? byMonthMgr.set(k, []).get(k)!).push(days);
      }
      const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
      const deptPools = new Map<string, number[]>(); // `${month}:${dept}`
      for (const [k, arr] of byMonthMgr) {
        const [month, mgr] = [k.slice(0, 10), Number(k.slice(11))];
        const dept = scopes.get(mgr)?.deptKey;
        if (!dept) continue;
        const dk = `${month}:${dept}`;
        (deptPools.get(dk) ?? deptPools.set(dk, []).get(dk)!).push(...arr);
      }
      for (const [k, arr] of byMonthMgr) {
        if (arr.length < minDeals) continue;
        const [month, mgr] = [k.slice(0, 10), Number(k.slice(11))];
        const dept = scopes.get(mgr)?.deptKey;
        if (!dept) continue;
        const pool = deptPools.get(`${month}:${dept}`);
        if (!pool || pool.length <= arr.length) continue; // в отделе должен быть кто-то ещё
        if (median(arr) < median(pool)) {
          awards.push({ bitrixId: mgr, badgeKey: 'faster_than_median', tier: null, periodType: 'month', periodDate: month, value: median(arr) });
        }
      }
    }

    // «Личный рекорд дня» + «День-миллионник» + стрики — от дневных сумм продаж
    const dayByMgr = new Map<number, { day: string; amount: number }[]>();
    for (const s of salesDaySums) {
      (dayByMgr.get(s.managerId) ?? dayByMgr.set(s.managerId, []).get(s.managerId)!).push({ day: s.day, amount: s.amount });
    }
    for (const list of dayByMgr.values()) list.sort((a, b) => a.day.localeCompare(b.day));

    if (enabled('personal_day_record')) {
      for (const [mgr, list] of dayByMgr) {
        let best = 0; let seenPrior = false;
        for (const { day, amount } of list) {
          if (seenPrior && day >= RETRO_START && day < today && amount > best) {
            awards.push({ bitrixId: mgr, badgeKey: 'personal_day_record', tier: null, periodType: 'day', periodDate: day, value: amount });
          }
          if (amount > best) best = amount;
          seenPrior = true;
        }
      }
    }

    if (enabled('million_day')) {
      const minAmount = num(crit('million_day'), 'minAmount', 1000000);
      for (const [mgr, list] of dayByMgr) {
        const n = list.filter(x => x.day >= RETRO_START && x.amount >= minAmount).length;
        if (n > 0) awards.push({ bitrixId: mgr, badgeKey: 'million_day', tier: null, periodType: null, periodDate: null, value: n, counter: true });
      }
    }

    for (const streak of [{ key: 'streak_5', len: 5 }, { key: 'streak_10', len: 10 }]) {
      if (!enabled(streak.key)) continue;
      const len = num(crit(streak.key), 'days', streak.len);
      for (const [mgr, list] of dayByMgr) {
        const saleDays = new Set(list.filter(x => x.amount > 0).map(x => x.day));
        let run = 0;
        for (let d = RETRO_START; d < today; d = addDays(d, 1)) {
          if (!isWorkDay(d)) continue; // выходные серию не рвут и не продлевают
          if (saleDays.has(d)) {
            run++;
            if (run === len) {
              awards.push({ bitrixId: mgr, badgeKey: streak.key, tier: null, periodType: 'day', periodDate: d, value: len });
            }
          } else run = 0;
        }
      }
    }

    // Вехи: первая продажа / сотня продаж / крупная рыба
    {
      const firstSale = new Map<number, string>();
      const totalSold = new Map<number, number>();
      const bigDeals = new Map<number, number>();
      const bigMin = num(crit('big_deal'), 'minAmount', 1000000);
      for (const d of sold) {
        if (!firstSale.has(d.managerId)) firstSale.set(d.managerId, d.soldDay);
        totalSold.set(d.managerId, (totalSold.get(d.managerId) ?? 0) + 1);
        if (d.amount >= bigMin && d.soldDay >= RETRO_START) bigDeals.set(d.managerId, (bigDeals.get(d.managerId) ?? 0) + 1);
      }
      if (enabled('first_sale')) {
        for (const [mgr, day] of firstSale) {
          if (day >= RETRO_START) awards.push({ bitrixId: mgr, badgeKey: 'first_sale', tier: null, periodType: 'day', periodDate: day, value: null });
        }
      }
      if (enabled('sales_100')) {
        const need = num(crit('sales_100'), 'count', 100);
        for (const [mgr, n] of totalSold) {
          if (n >= need) awards.push({ bitrixId: mgr, badgeKey: 'sales_100', tier: null, periodType: null, periodDate: null, value: n, counter: true });
        }
      }
      if (enabled('big_deal')) {
        for (const [mgr, n] of bigDeals) {
          awards.push({ bitrixId: mgr, badgeKey: 'big_deal', tier: null, periodType: null, periodDate: null, value: n, counter: true });
        }
      }
    }

    // «Чистая воронка» (недели)
    if (enabled('clean_week')) {
      const lifecycles = await fetchDealLifecycles();
      const byMgr = new Map<number, OpenDealRow[]>();
      for (const d of lifecycles) {
        (byMgr.get(d.managerId) ?? byMgr.set(d.managerId, []).get(d.managerId)!).push(d);
      }
      const soldWeekByMgr = new Map<string, boolean>(); // `${mgr}:${weekStart}` — была продажа
      for (const d of sold) soldWeekByMgr.set(`${d.managerId}:${weekStart(d.soldDay)}`, true);

      const firstWeek = weekStart(addDays(RETRO_START, 7)); // первая ПОЛНАЯ неделя после ретро-старта
      for (let ws = firstWeek; addDays(ws, 7) <= today; ws = addDays(ws, 7)) {
        const weekEnd = addDays(ws, 6); // воскресенье
        for (const [mgr, deals] of byMgr) {
          if (!soldWeekByMgr.get(`${mgr}:${ws}`)) continue; // активность недели обязательна
          let overdue = false;
          for (const d of deals) {
            if (d.createdDay > weekEnd) continue;
            if (d.closedDay !== null && d.closedDay <= weekEnd) continue; // уже закрыта
            if (workDaysBetween(d.createdDay, weekEnd) > cutoffForHeadGroup(d.headGroup)) { overdue = true; break; }
          }
          if (!overdue) {
            awards.push({ bitrixId: mgr, badgeKey: 'clean_week', tier: null, periodType: 'week', periodDate: ws, value: null });
          }
        }
      }
    }

    // Брони (reserved_at) — только для кастомных «Ежедневных бонусов»; выборка
    // лёгкая (тот же GROUP BY, что у продаж), тянем всегда — гейт по шаблонам
    // усложнил бы код сильнее, чем экономит.
    const bookingDaySums = await fetchDaySums('bookings');

    // ── Кастомные награды из конструктора (этап 2) ───────────────────────────
    // Generic-исполнители по criteria.template; данные переиспользуются из уже
    // сделанных выборок (daySums/transitions/sold) — доп. запросов в sa нет.
    // Битые criteria (невалидный шаблон) молча пропускаются: создание валидирует,
    // а ломать весь пересчёт из-за одной награды нельзя.
    for (const def of defs.values()) {
      if (!def.key.startsWith(CUSTOM_PREFIX) || def.enabled === false) continue;
      const v = validateCustomCriteria(def.criteria);
      if (!v.ok) continue;
      awards.push(...computeCustomBadge(def.key, v.criteria, {
        today, scopes, sold, transitions, bookingDaySums,
        metricSums: {
          sales_amount: salesDaySums,
          sales_count: salesDaySums,
          shipments_amount: shipmentDaySums,
          repeat_sales_count: repeatDaySums,
        },
      }));
    }

    // ── запись в БД ──────────────────────────────────────────────────────────
    let inserted = 0; let updated = 0;
    const byBadge: Record<string, number> = {};
    await client.query('BEGIN');
    for (const a of awards) {
      const onConflict = a.counter
        ? `DO UPDATE SET value = EXCLUDED.value WHERE badge_awards.value IS DISTINCT FROM EXCLUDED.value`
        : `DO NOTHING`;
      const res = await client.query<{ is_insert: boolean }>(
        `INSERT INTO badge_awards (bitrix_id, badge_key, tier, period_type, period_date, value)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (bitrix_id, badge_key, coalesce(tier,'-'), coalesce(period_type,'-'), coalesce(period_date,'0001-01-01'::date))
         ${onConflict}
         RETURNING (xmax = 0) AS is_insert`,
        [a.bitrixId, a.badgeKey, a.tier, a.periodType, a.periodDate, a.value],
      );
      if (res.rows.length > 0) {
        if (res.rows[0].is_insert) { inserted++; byBadge[a.badgeKey] = (byBadge[a.badgeKey] ?? 0) + 1; }
        else updated++;
      }
    }
    // Валюта (задача 2657): начисление за все награды без транзакции в леджере —
    // в ТОЙ ЖЕ транзакции, что и запись наград (ретро и ночной тик — один путь,
    // идемпотентно через UNIQUE badge_award_id, по цене на момент начисления).
    const coins = await accrueCoins(client);
    // Кошелёк (задача 31.07): истечение предметов инвентаря (возврат 50%),
    // сгорание EBALL-начислений старше ttl_months, пересчёт FIFO-остатков —
    // та же транзакция и тот же идемпотентный путь (ночной тик = ретро = кнопка).
    const wallet = await runWalletTick(client);
    await client.query('COMMIT');
    return { inserted, updated, total: awards.length, byBadge, ...coins, ...wallet, ms: Date.now() - t0 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
