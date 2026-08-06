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
import { BADGE_CATALOG, CROSS_SELL_PAIRS, TIER_LABELS, type BadgeTier } from './catalog';
import { getManagerScopes, type ManagerScope } from './orgScopes';
import { accrueCoins, getCurrencyName } from './coins';
import { runWalletTick } from './wallet';
import { CUSTOM_PREFIX, validateCustomCriteria, type CustomCriteria, type CustomMetric, type CustomPeriod } from './customTemplates';
import { computeXpTick, writeXpLedger, titleForLevel, levelFromXp, loadXpSettings, fetchQuestXp } from '@/features/xp/engine/xp';
import { questTick } from '@/features/quests/engine/quests';
import { computeCategoryBadgeAwards } from './categoryBadges';
import { computePlanningBadgeAwards } from './planningBadges';
import { computeWalletBadgeAwards } from './walletBadges';
import { pushViaAnalitik } from './notifications';

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
  // Гонка xp_ledger (задача 2776): true — другой прогон уже держит advisory-лок,
  // этот вызов ничего не считал и не писал (все счётчики выше — 0/{}).
  skipped?: boolean;
}

// Ключ pg-advisory-лока пересчёта наград — тот же стиль, что уже используется в
// проекте (gacha.ts, shop/transfer/route.ts): hashtext() от строкового ключа.
// int4 из hashtext() неявно приводится к bigint — единственному аргументу
// pg_try_advisory_lock(bigint)/pg_advisory_unlock(bigint).
const BADGE_RECOMPUTE_LOCK_SQL = `hashtext('badge_recompute')`;

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

interface DefRow { key: string; name: string; enabled: boolean; criteria: Record<string, unknown> }

async function loadDefs(client: PoolClient): Promise<Map<string, DefRow>> {
  const res = await client.query<DefRow>(`SELECT key, name, enabled, criteria FROM badge_definitions`);
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
  /** Минимум кандидатов в группе, чтобы победа считалась победой (правило
   *  релевантной выборки, решение владельца 05.08). Дефолт 2 — «лучший из
   *  одного» не награждается. Переопределяется через criteria бейджа. */
  minCompetitors?: number;
}

export const DEFAULT_MIN_COMPETITORS = 2;

function computeTopAwards(
  badgeKey: string,
  daySums: DaySum[],
  scopes: Map<number, ManagerScope>,
  minAmount: number,
  today: string,
  opts?: TopOpts,
): AwardRow[] {
  const value = opts?.value ?? ((s: DaySum) => s.amount);
  const minCompetitors = Math.max(1, opts?.minCompetitors ?? DEFAULT_MIN_COMPETITORS);
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
    // ПРАВИЛО РЕЛЕВАНТНОЙ ВЫБОРКИ (решение владельца 05.08): «лучший из одного» —
    // не победа. Живой случай: у менеджера 5 продаж за всю историю и «Топ продаж» ×5,
    // потому что в маленьком отделе за день/неделю продавал он один. Считаем не
    // только максимум, но и ЧИСЛО КАНДИДАТОВ группы (кто прошёл minAmount); группы
    // с одним кандидатом награду не дают. Порог настраивается через criteria
    // (minCompetitors) — тем же способом, что уже переопределяется minAmount.
    const best = (group: (s: ManagerScope | undefined) => string | null): Map<string, { max: number; winners: number[]; count: number }> => {
      const acc = new Map<string, { max: number; winners: number[]; count: number }>();
      for (const [mgr, sum] of sums) {
        if (sum < minAmount) continue;
        const g = group(scopes.get(mgr));
        if (g === null) continue;
        const cur = acc.get(g);
        if (!cur) acc.set(g, { max: sum, winners: [mgr], count: 1 });
        else {
          cur.count += 1;
          if (sum > cur.max) { cur.max = sum; cur.winners = [mgr]; }
          else if (sum === cur.max) cur.winners.push(mgr);
        }
      }
      // Группы без конкуренции отбрасываем целиком: на каждом уровне лесенки
      // (отдел → департамент → филиал → страна) проверка своя, поэтому подавленная
      // бронза не мешает выиграть серебро, если выше по структуре конкуренты есть.
      for (const [g, v] of acc) if (v.count < minCompetitors) acc.delete(g);
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
    const tiers: [BadgeTier, Map<string, { max: number; winners: number[]; count: number }>][] = [
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
      // minValue — минимальная планка результата (раньше был жёсткий литерал 1:
      // одна продажа на рубль позволяла в одиночку выиграть период); minCompetitors
      // — правило релевантной выборки, см. computeTopAwards.
      awards.push(...computeTopAwards(key, ctx.metricSums[c.metric!], ctx.scopes, c.minValue ?? 1, ctx.today, {
        periodTypes: new Set([c.period!]),
        tiered: c.tieredScopes === true,
        minCompetitors: c.minCompetitors ?? DEFAULT_MIN_COMPETITORS,
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

const EMPTY_STATS_SKIPPED = (ms: number): RecomputeStats => ({
  inserted: 0, updated: 0, total: 0, byBadge: {},
  coinsAccrued: 0, coinsEmitted: 0,
  expiredLedger: 0, expiredAmount: 0, expiredItems: 0, refundedAmount: 0,
  ms, skipped: true,
});

// Пересчёт наград — ЕДИНСТВЕННЫЙ путь и для ночного крона (instrumentation.ts,
// scheduleBadgeRecompute), и для ручной кнопки «Пересчитать» (POST
// /api/badges/recompute). Взаимоисключение — pg_try_advisory_lock на уровне
// Postgres, а не Redis (задача 2776, находка QA: параллельный запуск давал
// `duplicate key value violates unique constraint "xp_ledger_pkey"`, потому что
// Redis-лок в instrumentation.ts мог промолчать после ошибки ioredis, а
// ручная кнопка вообще не проверяла никакой лок). pg_try_advisory_lock —
// НЕ блокирующий (в отличие от pg_advisory_xact_lock, который уже используется
// в проекте) и session-scoped, а не transaction-scoped — держим его на этом же
// `client` от подключения до releasing, снимаем явно в finally, ДО
// `client.release()` (иначе лок повис бы до следующего заимствования
// соединения из пула, а не снялся бы сразу).
export async function runBadgeRecompute(): Promise<RecomputeStats> {
  const t0 = Date.now();
  const today = mskToday();
  const client = await systemDb().connect();
  let lockHeld = false;
  try {
    const lockRes = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${BADGE_RECOMPUTE_LOCK_SQL}) AS locked`,
    );
    lockHeld = lockRes.rows[0]?.locked === true;
    if (!lockHeld) {
      console.warn('[badges] пересчёт уже выполняется в другом прогоне (advisory-лок занят) — пропускаю');
      return EMPTY_STATS_SKIPPED(Date.now() - t0);
    }

    await seedDefinitions(client);
    const defs = await loadDefs(client);
    const enabled = (key: string) => defs.get(key)?.enabled !== false;
    const crit = (key: string) => defs.get(key)?.criteria ?? {};
    // Название валюты — один раз на весь прогон, все пуши ниже читают отсюда
    // (getCurrencyName(), НЕ литерал — задача 2747/2759).
    const currencyName = await getCurrencyName(client);

    // Снимок квестового XP ДО тика квестов (questTick ниже переводит часть
    // quests/quest_contracts в status='done' В ЭТОМ ЖЕ прогоне) — нужен для
    // корректного «было / стало» в level-up пуше (задача 2759): без снимка ДО
    // сравнение всегда показывало бы «прирост» на весь квестовый бонус, даже
    // если реально изменился только счётчик сделок.
    const questXpBefore = await fetchQuestXp(client);
    const xpSettingsForLevel = await loadXpSettings(client);
    const oldLedgerSumsRes = await client.query<{ bitrix_id: number; total: string }>(
      `SELECT bitrix_id::int AS bitrix_id, sum(total_xp)::text AS total FROM xp_ledger GROUP BY 1`,
    );
    const oldLevelByMgr = new Map<number, number>();
    for (const r of oldLedgerSumsRes.rows) {
      const total = Math.round(Number(r.total)) + (questXpBefore.get(r.bitrix_id) ?? 0);
      oldLevelByMgr.set(r.bitrix_id, levelFromXp(total, xpSettingsForLevel.levelBase, xpSettingsForLevel.levelExp));
    }

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
      // criteria.periodTypes — какие периоды вообще награждать (задача экономики
      // 06.08: ежедневные топы печатали баллы в каждом отделе каждый день и
      // размазывали бюджет тонким слоем; оставляем месяц/год, чтобы победа
      // что-то значила). Пусто/не задано — прежнее поведение: все периоды.
      const pt = crit(spec.key)?.periodTypes;
      const periodTypes = Array.isArray(pt) && pt.length > 0
        ? new Set(pt.filter((x): x is string => typeof x === 'string'))
        : undefined;
      awards.push(...computeTopAwards(spec.key, sums, scopes, num(crit(spec.key), 'minAmount', 1), today,
        { minCompetitors: num(crit(spec.key), 'minCompetitors', DEFAULT_MIN_COMPETITORS), periodTypes }));
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
        // Правило релевантной выборки (05.08): медиана отдела не может опираться
        // на одну случайную сделку коллеги — требуем от ОСТАЛЬНЫХ не меньше
        // наблюдений, чем требуем от самого менеджера (minDeals).
        if (pool.length - arr.length < minDeals) continue;
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
      // Правило релевантной выборки (05.08): «рекорд» относительно ОДНОГО
      // предыдущего дня — не рекорд (аналог «100% конверсии с одной сделки»).
      // Нужна база: минимум minPriorDays прошедших дней С ПРОДАЖЕЙ. Порог по
      // умолчанию 5 — согласован со streak_5. Максимум обновляем на ВСЕХ днях,
      // включая добазовые, чтобы после набора базы сравнение шло со всей историей.
      const minPriorDays = num(crit('personal_day_record'), 'minPriorDays', 5);
      for (const [mgr, list] of dayByMgr) {
        let best = 0; let priorSaleDays = 0;
        for (const { day, amount } of list) {
          if (priorSaleDays >= minPriorDays && day >= RETRO_START && day < today && amount > best) {
            awards.push({ bitrixId: mgr, badgeKey: 'personal_day_record', tier: null, periodType: 'day', periodDate: day, value: amount });
          }
          if (amount > best) best = amount;
          if (amount > 0) priorSaleDays++;
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
      // Минимальный живой пайплайн недели — порог настраивается через criteria.
      const minPipeline = num(crit('clean_week'), 'minPipeline', 3);
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
          // Правило релевантной выборки (05.08): «ни одной просрочки» из НУЛЯ
          // рассмотренных — вакуумная истина (тот же класс, что «дисциплина
          // броней» без броней). Знаменатель — сделки, ЖИВЫЕ на этой неделе
          // (созданы не позже конца недели и ещё не закрыты к её началу);
          // «чисто» теперь значит «чисто при реальном пайплайне недели».
          const inScope = deals.filter(d => d.createdDay <= weekEnd && (d.closedDay === null || d.closedDay >= ws));
          if (inScope.length < minPipeline) continue;
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

    // ── Квесты (миграция 125): экспирация, генерация всем активным, автозачёт
    // + квест-бейджи. ДО XP-тика: выполненные квесты дают XP в уровень.
    // Задача 2820: раньше ростер брался из sa.employees (мёртвая заготовка
    // 13.06) — 222 из 429 активных сотрудников (52%) НИКОГДА не получали
    // квесты, т.к. их id не было в activeIds. Источник — sa.org_resolved_hierarchy.
    try {
      const activeIds = await analyticsDb().query<{ id: number }>(
        `SELECT manager_bitrix_user_id::int AS id FROM sa.org_resolved_hierarchy WHERE is_active`,
      );
      const qt = await questTick(systemDb(), activeIds.rows.map(r => r.id));
      for (const a of qt.awards) {
        if (!enabled(a.badgeKey)) continue;
        awards.push({ bitrixId: a.bitrixId, badgeKey: a.badgeKey, tier: a.tier, periodType: a.periodType, periodDate: a.periodDate, value: a.value, counter: a.counter });
      }
    } catch (e) {
      // до применения миграции 125 таблиц квестов нет — тик не должен падать
      console.warn('[quests] тик пропущен:', e instanceof Error ? e.message : e);
    }

    // ── Награды за категории клиентов («Кит-мейкер»/«Апгрейд»/«Хранитель
    // ключей», ок Серёги 01.08): ретро и ночной тик — один идемпотентный путь.
    try {
      const catAwards = await computeCategoryBadgeAwards(today);
      for (const a of catAwards) {
        if (!enabled(a.badgeKey)) continue;
        awards.push(a);
      }
    } catch (e) {
      // до миграции 129 нет customer_category_settings — тик не должен падать
      console.warn('[categoryBadges] пропущено:', e instanceof Error ? e.message : e);
    }

    // ── Награды пула «Планёрка» (01.08): «Дисциплина броней»/«Камбэк»/«Досрочник» ─
    try {
      const planningAwards = await computePlanningBadgeAwards(today, RETRO_START);
      for (const a of planningAwards) {
        if (!enabled(a.badgeKey)) continue;
        awards.push(a);
      }
    } catch (e) {
      // до миграции 131 нет определений/manager_plans может быть недоступна — тик не должен падать
      console.warn('[planningBadges] пропущено:', e instanceof Error ? e.message : e);
    }

    // ── Ачивки по кошельку («Шопоголик»/«Инвестор»/«Удачливый», доп. Серёги
    // к задаче 2741, миграция 127): читает тот же systemDb-клиент (client),
    // до BEGIN — обычное чтение, как categoryBadges/planningBadges выше.
    try {
      const walletAwards = await computeWalletBadgeAwards(client);
      for (const a of walletAwards) {
        // defs.has(), не только enabled(): до миграции 127 ключей wallet_* нет
        // в badge_definitions вообще — INSERT в badge_awards упал бы по FK и
        // откатил бы ВЕСЬ пересчёт (не только эти три награды).
        if (!defs.has(a.badgeKey) || !enabled(a.badgeKey)) continue;
        awards.push(a);
      }
    } catch (e) {
      // до миграции 127 нет определений wallet_* — тик не должен падать
      console.warn('[walletBadges] пропущено:', e instanceof Error ? e.message : e);
    }

    // ── XP-система (миграция 124): леджер + награды XP-пула в общем тике ─────
    const xp = await computeXpTick(client, enabled);
    awards.push(...xp.awards);

    // Цены наград (задача 2759, пуш «начислена награда») — читаем ДО транзакции,
    // read-only, маленькая таблица.
    const pricesRes = await client.query<{ badge_key: string; tier: string; price: number }>(
      `SELECT badge_key, tier, price FROM badge_prices`,
    );
    const priceByKeyTier = new Map<string, number>(pricesRes.rows.map(r => [`${r.badge_key}:${r.tier}`, r.price]));

    // ── запись в БД ──────────────────────────────────────────────────────────
    let inserted = 0; let updated = 0;
    const byBadge: Record<string, number> = {};
    // Свежие НЕ-тихие награды за этот прогон, для пуша ниже (задача 2759, п.1):
    // criteria.silent=true (напр. «Ежедневный бонус», xp_level_up) — пропускаем,
    // level up обрабатывается отдельным, точным пушем (см. ниже), не отсюда.
    const freshAwardsByMgr = new Map<number, { name: string; tier: BadgeTier | null; price: number }[]>();
    await client.query('BEGIN');
    await writeXpLedger(client, xp.ledger);
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
        if (res.rows[0].is_insert) {
          inserted++; byBadge[a.badgeKey] = (byBadge[a.badgeKey] ?? 0) + 1;
          const def = defs.get(a.badgeKey);
          const silent = def?.criteria?.silent === true || a.badgeKey === 'xp_level_up';
          if (def && !silent) {
            // ЦЕНА = БАЗА × МНОЖИТЕЛЬ ПЕРИОДА (решение владельца 06.08: «за день
            // бронза, неделя — серебро, месяц — золото, год — платина»). В
            // движке тир — это МАСШТАБ победы (отдел → департамент → филиал →
            // страна), и терять его нельзя: победа над страной честно дороже
            // победы в своём отделе. Поэтому вторая ось — период — приходит
            // множителем из criteria.periodMultipliers ({day, week, month, year}).
            // Так дневная победа остаётся частым мелким «ништяком», а годовая —
            // событием. Нет множителей в criteria — прежнее поведение (×1).
            const basePrice = priceByKeyTier.get(`${a.badgeKey}:${a.tier ?? '-'}`) ?? 0;
            const pm = def.criteria?.periodMultipliers as Record<string, number> | undefined;
            const mult = pm && a.periodType && typeof pm[a.periodType] === 'number' ? pm[a.periodType] : 1;
            const price = Math.round(basePrice * mult);
            const list = freshAwardsByMgr.get(a.bitrixId) ?? [];
            list.push({ name: def.name, tier: a.tier as BadgeTier | null, price });
            freshAwardsByMgr.set(a.bitrixId, list);
          }
        } else updated++;
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

    // ── пуши ботом «Аналитик» (задача 2759) — ПОСЛЕ коммита, best-effort ─────
    // Награды (п.1): >4 за прогон на человека — сводкой одним сообщением.
    for (const [bitrixId, list] of freshAwardsByMgr) {
      if (list.length === 0) continue;
      if (list.length <= 4) {
        for (const it of list) {
          const label = it.tier ? `${it.name} (${TIER_LABELS[it.tier]})` : it.name;
          void pushViaAnalitik(bitrixId, `🏅 Новая награда: ${label}`, it.price > 0 ? `+${it.price} ${currencyName}` : undefined);
        }
      } else {
        const sum = list.reduce((s, it) => s + it.price, 0);
        const names = list.slice(0, 6).map(it => it.tier ? `${it.name} (${TIER_LABELS[it.tier]})` : it.name).join(', ');
        void pushViaAnalitik(bitrixId, `🏅 Начислено ${list.length} наград`,
          `${names}${list.length > 6 ? '…' : ''}${sum > 0 ? ` — суммарно +${sum} ${currencyName}` : ''}`);
      }
    }
    // Level up / новый титул (п.2): сравнение «было/стало» по totalsByMgr этого
    // тика vs снимку ДО (oldLevelByMgr, снят до тика квестов — см. выше).
    for (const [bitrixId, total] of xp.totalsByMgr) {
      const newLevel = levelFromXp(total, xpSettingsForLevel.levelBase, xpSettingsForLevel.levelExp);
      const oldLevel = oldLevelByMgr.get(bitrixId) ?? 0;
      if (newLevel <= oldLevel) continue;
      const oldTitle = titleForLevel(oldLevel);
      const newTitle = titleForLevel(newLevel);
      void pushViaAnalitik(bitrixId, `⬆️ Новый уровень: ${newLevel}`,
        oldTitle !== newTitle ? `Новый титул: ${newTitle}!` : `Титул: ${newTitle}`);
    }
    // «Скоро сгорит» (п.10): собрано в runWalletTick (тот же прогон, тот же
    // недельный дедуп по человеку, что у in-app уведомления).
    for (const w of wallet.expirySoonPushes) {
      void pushViaAnalitik(w.bitrixId, `🔥 Скоро сгорит ${w.amount} ${currencyName}`,
        `Через ${w.days} дн. истечёт срок жизни части начислений — потратьте их в магазине.`);
    }

    return { inserted, updated, total: awards.length, byBadge, ...coins, ...wallet, ms: Date.now() - t0 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    // Снимаем advisory-лок ДО возврата соединения в пул — иначе он держался
    // бы за скрытым pg-сеансом до следующего заимствования этого клиента.
    if (lockHeld) {
      await client.query(`SELECT pg_advisory_unlock(${BADGE_RECOMPUTE_LOCK_SQL})`).catch(err =>
        console.error('[badges] не удалось снять advisory-лок (сессия уйдёт в пул с висящим локом до её закрытия):', err));
    }
    client.release();
  }
}
