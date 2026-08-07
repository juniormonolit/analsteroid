// Квесты (миссии) в ЛК менеджера — реализация дизайн-дока Софьи
// (owners-inbox/monolitika-quests-design.md), утверждён Серёгой со сценарием
// наград В (5/15/60) и тирами сложности по ОБЪЕКТИВНОЙ шкале (схема v2):
//
//  * Слоты: 1 дневной + 2 недельных + 1 месячный (+extra — докупленные).
//  * Персонализация: профиль слабостей за 3 мес против медианы отдела
//    (повторка 1.3 > допродажа 1.2 > группа 1.0 = объём 1.0); двум недельным
//    слотам — две верхние слабости, месячному — верхняя, дневному — ротация
//    простых продажных целей. Гигиенические квесты отложены до внедрения
//    отсечки перезвонов (ограничение №4 дизайн-дока) — дневной слот работает
//    на продажах.
//  * Достижимость: цель = clamp(round(1.2 × личная медиана за 6 аналогичных
//    периодов), 1, личный p90); допуск группового квеста — лиды группы за 90
//    дней >= 3 × цели И >= 2 продажи группы; антиабьюз — перевыполняющим
//    (факт >= цели в 3 из 4 последних периодов) цель = max(1.2×медиана,
//    1.15×p75), ежедневно продаваемая группа (>= 4/нед) квестом не становится;
//    допродажный квест только при >= 3 клиентах с первой группой пары за 60 дн.
//  * ТИР (схема v2) = сложность цели относительно МЕДИАННОГО менеджера
//    компании по метрике за аналогичный период: белый <= 50%, зелёный 50–80%,
//    синий 80–110%, эпик 110–150%, легендарный > 150%. Награда по тиру
//    одинакова у всех: база сценария В — СИНИЙ тир, множители
//    0.4/0.7/1/2/4 (quest_settings.tier_mult). Легендарный — мягкий гейт по
//    XP-титулу Мастер+ (уровень >= 15), иначе цель прижимается к эпик-полосе.
//  * Награды: ебаллы в общий леджер (source='quest') + XP (xp_mult × ебаллы,
//    учитывается в уровне через xp-движок) + уведомление (колокольчик +
//    Битрикс-бот «Аналитик»). Провал = ничего, квест сгорает молча.
//  * Реролл: замена квеста ТОГО ЖЕ типа (цены 10/20/50), макс 1 на квест;
//    докуп доп. дневного 30 (×2 за каждый следующий в неделе, макс 1/день).
//  * Цели фиксируются на момент генерации (задним числом не пересчитываются).

import type { Pool, PoolClient } from 'pg';
import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { fetchCrossSellMatrix } from '@/features/customers/engine/crossSell';
import { CLIENT_KEY_CASE_SQL } from '@/features/customers/engine/clientKey';
import { createNotification, pushViaAnalitik } from '@/features/badges/engine/notifications';
import { getCurrencyName } from '@/features/badges/engine/coins';
import { isWorkingDayJs } from '@/lib/metrics/productionCalendar';
import { spendPinRequirement, verifyPin, type PinActorCtx } from '@/lib/auth/pin';
import { loadQuestTemplates, matchesAudience, type QuestTemplate } from './templates';
import {
  metricCompanyMedian, metricPersonalSeries, metricQuestProgress, resolveQuestMetric,
} from './metricQuests';

// Результат операций кошелька квестов (реролл/докуп) — error теперь может
// нести HTTP-статус (задача #2995): без пина -> 428, неверный -> 403,
// лок -> 423, иначе 400 (дефолт в самом роуте).
type PinGatedResult<T> = { ok: true; quest: T } | { ok: false; error: string; status?: number };

const MSK = 'Europe/Moscow';

export type QuestSlot = 'day' | 'week1' | 'week2' | 'month' | 'extra';
export type QuestPeriod = 'day' | 'week' | 'month';
// 'metric' — квест на произвольную метрику каталога (конструктор, задача 60):
// не отдельная логика, а дискриминатор «цель и прогресс считает универсальный
// вычислитель из metricQuests.ts по `quests.metric_id`».
export type QuestCategory = 'sales_count' | 'sales_amount' | 'group_sales' | 'repeat_sales' | 'crosssell' | 'distinct_groups' | 'bookings_count' | 'metric';
export type QuestTier = 'white' | 'green' | 'blue' | 'epic' | 'legendary';
export type QuestStatus = 'active' | 'done' | 'failed' | 'rerolled';

export const TIER_LABELS: Record<QuestTier, string> = {
  white: 'Обычный', green: 'Необычный', blue: 'Редкий', epic: 'Эпический', legendary: 'Легендарный',
};
export const TIER_ORDER: QuestTier[] = ['white', 'green', 'blue', 'epic', 'legendary'];

export interface QuestSettings {
  rewardDay: number; rewardWeek: number; rewardMonth: number;
  tierMult: Record<QuestTier, number>;
  xpMult: number;
  rerollDay: number; rerollWeek: number; rerollMonth: number; extraDay: number;
}

export async function loadQuestSettings(db: Pool | PoolClient): Promise<QuestSettings> {
  const r = await db.query<Record<string, unknown>>(`SELECT * FROM quest_settings WHERE id = 1`);
  const row = r.rows[0] ?? {};
  const n = (k: string, d: number) => (row[k] != null ? Number(row[k]) : d);
  const tm = (row.tier_mult ?? {}) as Record<string, number>;
  return {
    rewardDay: n('reward_day', 5), rewardWeek: n('reward_week', 15), rewardMonth: n('reward_month', 60),
    tierMult: {
      white: Number(tm.white ?? 0.4), green: Number(tm.green ?? 0.7), blue: Number(tm.blue ?? 1),
      epic: Number(tm.epic ?? 2), legendary: Number(tm.legendary ?? 4),
    },
    xpMult: n('xp_mult', 5),
    rerollDay: n('reroll_day', 10), rerollWeek: n('reroll_week', 20), rerollMonth: n('reroll_month', 50),
    extraDay: n('extra_day', 30),
  };
}

// ── календарь (все даты — YYYY-MM-DD в МСК) ─────────────────────────────────

export function mskToday(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: MSK });
}
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function isoDow(iso: string): number { const d = new Date(`${iso}T12:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; }
function weekStart(iso: string): string { return addDays(iso, 1 - isoDow(iso)); }
function monthStart(iso: string): string { return `${iso.slice(0, 7)}-01`; }
function monthEnd(iso: string): string { return addDays(monthStart(addDays(monthStart(iso), 40)), -1); }
export function isWorkDay(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number);
  return isWorkingDayJs(y, m, d, isoDow(iso));
}

export function periodBounds(period: QuestPeriod, today: string): { start: string; end: string } {
  if (period === 'day') return { start: today, end: today };
  if (period === 'week') { const s = weekStart(today); return { start: s, end: addDays(s, 6) }; }
  return { start: monthStart(today), end: monthEnd(today) };
}

// ── калибровка: медианы компании (объективная шкала тиров) ──────────────────

function median(a: number[]): number | null {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(a: number[], p: number): number | null {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

export interface CompanyMedians {
  // по типу периода: медиана метрики МЕДИАННОГО менеджера компании
  [period: string]: Partial<Record<QuestCategory, number>>;
}

/** Медианы компании по (метрика × период) — база объективной шкалы тиров.
 *  Считаются по менеджеро-периодам с активностью за последние 8 недель /
 *  6 месяцев (как в калибровке дизайн-дока), Redis 6ч. */
export async function fetchCompanyMedians(): Promise<CompanyMedians> {
  // v3 — добавлены брони (задача 59), форма кэша изменилась.
  return cached('quests:company-medians:v3', 6 * 3600, async () => {
    const res = await analyticsDb().query<{
      period: string; mgr: number; cnt: string; amt: string; rep: string; grp: string;
    }>(`
      WITH sold AS (
        SELECT d.current_manager_id AS mgr, (d.sold_at AT TIME ZONE '${MSK}')::date AS day,
               coalesce(d.amount,0) AS amount, coalesce(f.is_repeat,false) AS is_repeat,
               d.head_group_name
        FROM sa.deals d LEFT JOIN sa.funnels f ON f.id = d.funnel_id
        WHERE d.sold_at IS NOT NULL AND d.current_manager_id IS NOT NULL
          AND d.sold_at >= now() - interval '190 days' AND coalesce(d.amount,0) < 100000000
      )
      SELECT 'week' AS period, mgr,
             count(*)::text AS cnt, sum(amount)::text AS amt,
             count(*) FILTER (WHERE is_repeat)::text AS rep,
             count(DISTINCT head_group_name)::text AS grp
      FROM sold WHERE day >= (now() AT TIME ZONE '${MSK}')::date - 56
      GROUP BY 2, date_trunc('week', day)
      UNION ALL
      SELECT 'month', mgr, count(*)::text, sum(amount)::text,
             count(*) FILTER (WHERE is_repeat)::text,
             count(DISTINCT head_group_name)::text
      FROM sold GROUP BY 2, date_trunc('month', day)
      UNION ALL
      SELECT 'day', mgr, count(*)::text, sum(amount)::text,
             count(*) FILTER (WHERE is_repeat)::text,
             count(DISTINCT head_group_name)::text
      FROM sold WHERE day >= (now() AT TIME ZONE '${MSK}')::date - 30
      GROUP BY 2, day
    `);
    // Брони (задача 59) — отдельным запросом, а не колонкой в предыдущем:
    // менеджеро-период с бронями и без продаж (и наоборот) существует, при
    // джойне такие строки либо пропали бы, либо принесли фиктивные нули в
    // чужие ряды. Оба запроса под общим кэшем на 6 часов.
    const bkgRes = await analyticsDb().query<{ period: string; mgr: number; bkg: string }>(`
      WITH booked AS (
        SELECT d.current_manager_id AS mgr, (d.reserved_at AT TIME ZONE '${MSK}')::date AS day
        FROM sa.deals d
        WHERE d.reserved_at IS NOT NULL AND d.current_manager_id IS NOT NULL
          AND d.reserved_at >= now() - interval '190 days' AND coalesce(d.amount,0) < 100000000
      )
      SELECT 'week' AS period, mgr, count(*)::text AS bkg
      FROM booked WHERE day >= (now() AT TIME ZONE '${MSK}')::date - 56
      GROUP BY 2, date_trunc('week', day)
      UNION ALL
      SELECT 'month', mgr, count(*)::text FROM booked GROUP BY 2, date_trunc('month', day)
      UNION ALL
      SELECT 'day', mgr, count(*)::text
      FROM booked WHERE day >= (now() AT TIME ZONE '${MSK}')::date - 30
      GROUP BY 2, day
    `);
    const acc: Record<string, { cnt: number[]; amt: number[]; rep: number[]; grp: number[]; bkg: number[] }> = {};
    const bucket = (p: string) => (acc[p] ??= { cnt: [], amt: [], rep: [], grp: [], bkg: [] });
    for (const r of res.rows) {
      const a = bucket(r.period);
      a.cnt.push(Number(r.cnt)); a.amt.push(Number(r.amt));
      a.rep.push(Number(r.rep)); a.grp.push(Number(r.grp));
    }
    for (const r of bkgRes.rows) bucket(r.period).bkg.push(Number(r.bkg));
    const out: CompanyMedians = {};
    // Полы редких категорий (v2 калибровки): у «продай группу Y» и «допродай
    // пару» медианная база на менеджера < 1 за период — без пола цель «1 штука»
    // взлетала в легендарный тир (поймано живьём на первом прогоне). Полы
    // выбраны так, чтобы типовые цели (1 допродажа/нед, 2-3 группы/нед) давали
    // синий-эпик, а не легендарку.
    const FLOORS: Record<string, Partial<Record<QuestCategory, number>>> = {
      day: { group_sales: 0.5, crosssell: 0.5 },
      week: { group_sales: 1.5, crosssell: 1 },
      month: { group_sales: 4, crosssell: 2 },
    };
    for (const [period, a] of Object.entries(acc)) {
      const fl = FLOORS[period] ?? {};
      out[period] = {
        sales_count: median(a.cnt) ?? 1,
        sales_amount: median(a.amt) ?? 500000,
        repeat_sales: Math.max(median(a.rep) ?? 1, 1),
        // групповой квест и допродажа: база ≈ медиана продаж одной группы =
        // медиана продаж / медиана различных групп, но не ниже пола.
        group_sales: Math.max((median(a.cnt) ?? 1) / Math.max(median(a.grp) ?? 1, 1), fl.group_sales ?? 0.5),
        crosssell: Math.max((median(a.rep) ?? 1) / 2, fl.crosssell ?? 0.5),
        distinct_groups: Math.max(median(a.grp) ?? 1, 1),
        // Брони: свой ряд, пол 1 — как у продаж, без искусственных подпорок
        // (замер 07.08: неделя 8, месяц 15, день 2 — база и так не вырожденная).
        bookings_count: Math.max(median(a.bkg) ?? 1, 1),
      };
    }
    return out;
  });
}

/** Тир = сложность цели относительно медианного менеджера компании.
 *  `baseOverride` — для квестов на произвольной метрике (задача 60): их базы нет
 *  в `CompanyMedians`, она считается отдельно в metricQuests.metricCompanyMedian. */
export function tierForTarget(
  category: QuestCategory, period: QuestPeriod, target: number, cm: CompanyMedians,
  baseOverride?: number | null,
): QuestTier {
  const base = baseOverride != null && baseOverride > 0 ? baseOverride : (cm[period]?.[category] ?? 1);
  const ratio = target / Math.max(base, 0.0001);
  if (ratio <= 0.5) return 'white';
  if (ratio <= 0.8) return 'green';
  if (ratio <= 1.1) return 'blue';
  if (ratio <= 1.5) return 'epic';
  return 'legendary';
}

// ── персональная калибровка менеджера ────────────────────────────────────────

interface PersonalStats {
  weekly: { cnt: number[]; amt: number[]; rep: number[]; bkg: number[] };   // 6 последних ПОЛНЫХ недель
  monthly: { cnt: number[]; amt: number[]; rep: number[]; grp: number[]; bkg: number[] }; // 6 полных месяцев
  daily: { cnt: number[] };                                   // рабочие дни за 30 дн
  // Дневного ряда броней тут нет намеренно: дневной слот брони не выдаёт
  // (buildCandidates зовётся только с 'week'/'month'), а тянуть ряд «на будущее»
  // — лишний UNION в горячем запросе. Понадобится — вернуть три строки.
  groups: { group: string; leads90: number; sales90: number; weeklyRate: number }[];
  pairClients: Map<string, number>;   // first_group -> клиентов, купивших её за 60 дн
  deptId: string | null;
}

async function fetchPersonal(mgr: number): Promise<PersonalStats> {
  const [series, groups, pairs, dept] = await Promise.all([
    analyticsDb().query<{ period: string; k: string; cnt: string; amt: string; rep: string; grp: string }>(`
      WITH sold AS (
        SELECT (d.sold_at AT TIME ZONE '${MSK}')::date AS day, coalesce(d.amount,0) AS amount,
               coalesce(f.is_repeat,false) AS is_repeat, d.head_group_name
        FROM sa.deals d LEFT JOIN sa.funnels f ON f.id = d.funnel_id
        WHERE d.sold_at IS NOT NULL AND d.current_manager_id = $1
          AND d.sold_at >= now() - interval '200 days' AND coalesce(d.amount,0) < 100000000
      ), booked AS (
        -- Брони (задача 59): та же нарезка периодов, дата — reserved_at.
        SELECT (d.reserved_at AT TIME ZONE '${MSK}')::date AS day
        FROM sa.deals d
        WHERE d.reserved_at IS NOT NULL AND d.current_manager_id = $1
          AND d.reserved_at >= now() - interval '200 days' AND coalesce(d.amount,0) < 100000000
      )
      SELECT 'week' AS period, date_trunc('week', day)::date::text AS k, count(*)::text AS cnt,
             sum(amount)::text AS amt, count(*) FILTER (WHERE is_repeat)::text AS rep, '0' AS grp
      FROM sold WHERE day >= date_trunc('week', (now() AT TIME ZONE '${MSK}')::date)::date - 42
             AND day < date_trunc('week', (now() AT TIME ZONE '${MSK}')::date)::date
      GROUP BY 2
      UNION ALL
      SELECT 'month', date_trunc('month', day)::date::text, count(*)::text, sum(amount)::text,
             count(*) FILTER (WHERE is_repeat)::text, count(DISTINCT head_group_name)::text
      FROM sold WHERE day < date_trunc('month', (now() AT TIME ZONE '${MSK}')::date)::date
      GROUP BY 2
      UNION ALL
      SELECT 'day', day::text, count(*)::text, sum(amount)::text, '0', '0'
      FROM sold WHERE day >= (now() AT TIME ZONE '${MSK}')::date - 30 GROUP BY 2
      UNION ALL
      SELECT 'week_b', date_trunc('week', day)::date::text, count(*)::text, '0', '0', '0'
      FROM booked WHERE day >= date_trunc('week', (now() AT TIME ZONE '${MSK}')::date)::date - 42
             AND day < date_trunc('week', (now() AT TIME ZONE '${MSK}')::date)::date
      GROUP BY 2
      UNION ALL
      SELECT 'month_b', date_trunc('month', day)::date::text, count(*)::text, '0', '0', '0'
      FROM booked WHERE day < date_trunc('month', (now() AT TIME ZONE '${MSK}')::date)::date
      GROUP BY 2
    `, [mgr]),
    analyticsDb().query<{ g: string; leads90: string; sales90: string }>(`
      SELECT p->>'head_group_name' AS g,
             count(DISTINCT d.deal_id) FILTER (WHERE d.created_at >= now() - interval '90 days') AS leads90,
             count(DISTINCT d.deal_id) FILTER (WHERE d.sold_at >= now() - interval '90 days') AS sales90
      FROM sa.deals d, jsonb_array_elements(d.products) p
      WHERE d.current_manager_id = $1 AND d.created_at >= now() - interval '90 days'
        AND coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
        AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)'
      GROUP BY 1
    `, [mgr]),
    analyticsDb().query<{ g: string; clients: string }>(`
      SELECT p->>'head_group_name' AS g,
             count(DISTINCT (${CLIENT_KEY_CASE_SQL})) AS clients
      FROM sa.deals d, jsonb_array_elements(d.products) p
      WHERE d.current_manager_id = $1 AND d.sold_at >= now() - interval '60 days'
        AND d.funnel_id IN (0,1,2,3)
        AND (${CLIENT_KEY_CASE_SQL}) IS NOT NULL
        AND coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
        AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)'
      GROUP BY 1
    `, [mgr]),
    analyticsDb().query<{ department_id: string | null }>(`
      SELECT department_id::text FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id = $1::text LIMIT 1
    `, [mgr]),
  ]);
  const weekly = { cnt: [] as number[], amt: [] as number[], rep: [] as number[], bkg: [] as number[] };
  const monthly = { cnt: [] as number[], amt: [] as number[], rep: [] as number[], grp: [] as number[], bkg: [] as number[] };
  const daily = { cnt: [] as number[] };
  const monthsSorted = series.rows.filter(r => r.period === 'month').sort((a, b) => a.k.localeCompare(b.k)).slice(-6);
  const monthsBkgSorted = series.rows.filter(r => r.period === 'month_b').sort((a, b) => a.k.localeCompare(b.k)).slice(-6);
  for (const r of series.rows) {
    if (r.period === 'week') { weekly.cnt.push(Number(r.cnt)); weekly.amt.push(Number(r.amt)); weekly.rep.push(Number(r.rep)); }
    if (r.period === 'day') daily.cnt.push(Number(r.cnt));
    if (r.period === 'week_b') weekly.bkg.push(Number(r.cnt));
  }
  for (const r of monthsSorted) {
    monthly.cnt.push(Number(r.cnt)); monthly.amt.push(Number(r.amt));
    monthly.rep.push(Number(r.rep)); monthly.grp.push(Number(r.grp));
  }
  for (const r of monthsBkgSorted) monthly.bkg.push(Number(r.cnt));
  return {
    weekly, monthly, daily,
    groups: groups.rows.map(r => ({
      group: r.g, leads90: Number(r.leads90), sales90: Number(r.sales90),
      weeklyRate: Number(r.sales90) / (90 / 7),
    })),
    pairClients: new Map(pairs.rows.map(r => [r.g, Number(r.clients)])),
    deptId: dept.rows[0]?.department_id ?? null,
  };
}

/** Медианы отдела (для профиля слабостей) — Redis 6ч на отдел.
 *  `bkgWeek` — брони отдела в пересчёте на неделю (задача 59): медиана по
 *  менеджерам от их броней за 90 дней, делённая на 90/7. */
async function fetchDeptMedians(deptId: string | null): Promise<{ repShare: number; grp: number; bkgWeek: number }> {
  const key = `quests:dept-medians:v2:${deptId ?? 'none'}`;
  const deptJoin = deptId
    ? `JOIN sa.org_resolved_hierarchy h ON h.manager_bitrix_user_id = d.current_manager_id::text AND h.department_id::text = '${deptId.replace(/'/g, '')}'`
    : '';
  return cached(key, 6 * 3600, async () => {
    // Брони — отдельным запросом: у общего WHERE здесь sold_at, и подмешивать в
    // него reserved_at значило бы переопределить знаменатель repShare/grp,
    // на которых профиль слабостей откалиброван.
    const [res, bkg] = await Promise.all([
      analyticsDb().query<{ mgr: number; cnt: string; rep: string; grp: string }>(`
        SELECT d.current_manager_id AS mgr, count(*)::text AS cnt,
               count(*) FILTER (WHERE coalesce(f.is_repeat,false))::text AS rep,
               count(DISTINCT d.head_group_name)::text AS grp
        FROM sa.deals d LEFT JOIN sa.funnels f ON f.id = d.funnel_id
        ${deptJoin}
        WHERE d.sold_at >= now() - interval '90 days' AND d.current_manager_id IS NOT NULL
        GROUP BY 1 HAVING count(*) >= 3
      `),
      analyticsDb().query<{ mgr: number; bkg: string }>(`
        SELECT d.current_manager_id AS mgr, count(*)::text AS bkg
        FROM sa.deals d
        ${deptJoin}
        WHERE d.reserved_at >= now() - interval '90 days' AND d.current_manager_id IS NOT NULL
        GROUP BY 1 HAVING count(*) >= 3
      `),
    ]);
    const shares = res.rows.map(r => Number(r.rep) / Math.max(Number(r.cnt), 1));
    const grps = res.rows.map(r => Number(r.grp));
    const bkgs = bkg.rows.map(r => Number(r.bkg) / (90 / 7));
    return { repShare: median(shares) ?? 0.2, grp: median(grps) ?? 6, bkgWeek: median(bkgs) ?? 8 };
  });
}

// ── генерация ────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** Цель квеста из личного ряда результатов.
 *
 *  Планка — ЛИЧНЫЙ p75 («лучше трёх четвертей своих же периодов»), но не ниже
 *  «медиана + 1»: у ровного исполнителя p75 совпадает с медианой, и без этого
 *  пола квест был бы «повтори обычный день».
 *
 *  Было `1.2 × медиана` (решение владельца 06.08.2026 поднять до Q3): при
 *  недельной медиане 6 это давало цель 7 — прибавка, которую человек не
 *  замечает. Сверка планки с компанией (замер 06.08 по 116 активным): продажи
 *  день медиана 1 / Q3 2, неделя 6 / 10, месяц 27 / 42; брони неделя 9 / 15,
 *  месяц 41 / 65. То есть личный p75 у среднего менеджера ложится ровно на
 *  общекомпанейский Q3, а у слабого остаётся достижимым — чего фиксированный
 *  порог «10 продаж в неделю всем» не дал бы (у Q1-менеджера это 3 продажи,
 *  цель была бы недосягаема весь год). */
function targetFrom(
  series: number[], antiAbuseTarget = true, floor = 0,
  // Шаг округления цели. Штуки — до единицы; деньги — до 10 тысяч (задача 60:
  // метрика каталога может быть денежной, «продай на 517 384 ₽» — не цель).
  round: (v: number) => number = Math.round,
): { target: number; median: number; p75: number; p90: number } {
  const med = median(series) ?? 0;
  const p75 = pct(series, 0.75) ?? med;
  const p90 = pct(series, 0.90) ?? Math.max(med * 2, 1);
  const ceiling = Math.max(round(p90), round(med) + 1, round(floor), 1);
  let target = clamp(Math.max(round(p75), round(med) + 1, round(floor)), 1, ceiling);
  if (antiAbuseTarget) {
    // Перевыполняющий (факт >= цели в 3 из 4 последних периодов) — цель выше.
    const last4 = series.slice(-4);
    const hits = last4.filter(v => v >= target).length;
    if (last4.length === 4 && hits >= 3) {
      target = Math.max(target, round(1.15 * p75));
    }
  }
  return { target: Math.max(target, 1), median: med, p75, p90 };
}

interface GenQuest {
  slot: QuestSlot; period: QuestPeriod; category: QuestCategory;
  target: number; targetGroup: string | null; pairFirst: string | null;
  title: string; meta: Record<string, unknown>;
  // Ниже — только для квестов из конструктора (задача 60); у встроенных пусто.
  metricId?: string | null;      // category='metric': какая метрика каталога
  metricLabel?: string;          // её человеческое имя — для заголовка
  money?: boolean;               // dataType='money' → цель печатается рублями
  pct?: boolean;                 // dataType='percent' → к цели дописывается «%»
  templateId?: number | null;    // из какого шаблона выдан
  rewardOverride?: number | null; // шаблон задал награду жёстко, мимо тира
  tierBase?: number | null;      // база тира (медиана компании по этой метрике)
}

const fmtMoney = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1).replace('.0', '')} млн ₽` : `${Math.round(v / 1000)} тыс ₽`;

/** Русское склонение по числу: [1, 2-4, 5+]. Простое `n < 5 ? 'сделки' :
 *  'сделок'` врало на втором десятке — «41 сделок», «42 сделок». Раньше это не
 *  всплывало (месячные цели по продажам редко переваливали за 20), но месячная
 *  цель по броням — сорок с лишним, там видно сразу. */
function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(Math.round(n)) % 100;
  if (a >= 11 && a <= 14) return forms[2];
  const d = a % 10;
  return d === 1 ? forms[0] : d >= 2 && d <= 4 ? forms[1] : forms[2];
}
const DEALS_FORMS: [string, string, string] = ['сделку', 'сделки', 'сделок'];

function buildTitle(q: GenQuest, endLabel: string): string {
  switch (q.category) {
    case 'sales_count': return `Продай ${q.target} ${plural(q.target, DEALS_FORMS)} ${endLabel}`;
    case 'bookings_count': return `Забронируй ${q.target} ${plural(q.target, DEALS_FORMS)} ${endLabel}`;
    case 'sales_amount': return `Продай на ${fmtMoney(q.target)} ${endLabel}`;
    case 'group_sales': return `Продай «${q.targetGroup}» ${q.target} раз${q.target < 5 && q.target > 1 ? 'а' : ''} ${endLabel}`;
    case 'repeat_sales': return `Сделай ${q.target} ${plural(q.target, ['повторную продажу', 'повторные продажи', 'повторных продаж'])} ${endLabel}`;
    case 'crosssell': return `Допродай «${q.targetGroup}» клиенту, купившему «${q.pairFirst}» (${q.target} шт.) ${endLabel}`;
    case 'distinct_groups': return `Продай ${q.target} разных товарных групп ${endLabel}`;
    // Квест из конструктора на произвольной метрике: имя метрики берём из
    // каталога, чтобы формулировка совпадала с тем, как показатель называется
    // в отчётах. Владелец может перебить своей формулировкой (title_template).
    case 'metric': return `${q.metricLabel ?? 'Показатель'}: ${fmtTarget(q)} ${endLabel}`;
  }
}

/** Цель в тексте: деньги — рублями, проценты — с «%», остальное числом. */
function fmtTarget(q: GenQuest): string {
  if (q.money) return fmtMoney(q.target);
  const n = String(Math.round(q.target * 100) / 100);
  return q.pct ? `${n} %` : n;
}

/** Подстановки в пользовательскую формулировку шаблона.
 *
 *  `{target}` — цель, `{metric}` — имя показателя, `{when}` — «до воскресенья».
 *  Отдельно `{target:бронь|брони|броней}` — цель со склонением по числу: без
 *  этого владелец пишет «{target} броней» и получает «3 броней» (поймано на
 *  первом же живом предпросмотре). Формы задаются в порядке 1 / 2-4 / 5+. */
function applyTitleTemplate(tpl: string, q: GenQuest, endLabel: string): string {
  const target = fmtTarget(q);
  return tpl
    .replace(/\{target:([^|}]+)\|([^|}]+)\|([^}]+)\}/g,
      (_, one: string, few: string, many: string) =>
        `${target} ${plural(q.target, [one.trim(), few.trim(), many.trim()])}`)
    .replaceAll('{target}', target)
    .replaceAll('{metric}', q.metricLabel ?? '')
    .replaceAll('{when}', endLabel)
    .trim();
}

const endLabelFor = (p: QuestPeriod) =>
  p === 'day' ? 'сегодня' : p === 'week' ? 'до воскресенья' : 'за месяц';

/** Кандидаты из шаблонов конструктора (задача 60).
 *
 *  Шаблон не подменяет движок, а параметризует его: правила подбора цели
 *  (личный p75 / медиана / фикс), пол, потолок и тир остаются здесь, шаблон
 *  говорит только «на чём», «за какой период», «кому» и «с каким весом».
 *
 *  Балл кандидата = `weight` шаблона. Встроенные баллы лежат в диапазоне
 *  0.25–1.3, поэтому дефолтная единица ставит шаблон выше любой дефолтной
 *  продажной цели, но ниже ярко выраженной слабости — это и имелось в виду под
 *  «весом в выдаче».
 *
 *  Падение одного шаблона (метрику удалили из каталога, БД моргнула) не должно
 *  лишать человека всех квестов: такой шаблон просто пропускается. */
async function templateCandidates(
  db: Pool | PoolClient, mgr: number, period: QuestPeriod,
  ctx: { deptId: string | null; xpLevel: number }, cmed: CompanyMedians,
  ps: PersonalStats, today: string,
): Promise<{ score: number; q: GenQuest }[]> {
  const templates = (await loadQuestTemplates(db, period))
    .filter(t => matchesAudience(t, { deptId: ctx.deptId, xpLevel: ctx.xpLevel, mgr }));
  if (templates.length === 0) return [];
  const endLabel = endLabelFor(period);
  const out: { score: number; q: GenQuest }[] = [];

  for (const t of templates) {
    try {
      const q = t.kind === 'metric'
        ? await metricTemplateQuest(t, mgr, period, endLabel, today)
        : categoryTemplateQuest(t, period, endLabel, cmed, ps);
      if (q) out.push({ score: t.weight, q });
    } catch (e) {
      console.warn(`[quests] шаблон ${t.id} «${t.name}» пропущен:`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/** Цель по способу расчёта шаблона. */
function targetByMode(
  t: QuestTemplate, series: number[], companyMedian: number, round: (v: number) => number,
): { target: number; meta: Record<string, unknown> } {
  const floor = t.targetFloor ?? companyMedian;
  if (t.targetMode === 'fixed') {
    return { target: Math.max(t.targetFixed ?? 1, 1), meta: { mode: 'fixed' } };
  }
  if (t.targetMode === 'company_median') {
    const v = Math.max(round(companyMedian), 1);
    return { target: v, meta: { mode: 'company_median', companyMedian } };
  }
  const stat = targetFrom(series, t.targetMode === 'personal_p75', floor, round);
  const target = t.targetMode === 'personal_median'
    ? Math.max(round(stat.median) + 1, round(floor), 1)
    : stat.target;
  const capped = t.targetCeiling != null ? Math.min(target, t.targetCeiling) : target;
  return { target: Math.max(capped, 1), meta: { mode: t.targetMode, floor, ...stat } };
}

/** Шаблон на произвольной метрике каталога. */
async function metricTemplateQuest(
  t: QuestTemplate, mgr: number, period: QuestPeriod, endLabel: string, today: string,
): Promise<GenQuest | null> {
  if (!t.metricId) return null;
  const resolved = await resolveQuestMetric(t.metricId);
  if (!resolved) return null;  // метрику удалили или она не поддержана
  const money = resolved.metric.dataType === 'money';
  const round = money ? (v: number) => Math.round(v / 10000) * 10000 : Math.round;

  const [series, companyMedian] = await Promise.all([
    t.targetMode === 'fixed' ? Promise.resolve([] as number[]) : metricPersonalSeries(t.metricId, mgr, period, today),
    metricCompanyMedian(t.metricId, period, today),
  ]);
  const { target, meta } = targetByMode(t, series, companyMedian, round);
  const q: GenQuest = {
    slot: period === 'day' ? 'day' : period === 'month' ? 'month' : 'week1',
    period, category: 'metric', target,
    targetGroup: null, pairFirst: null, title: '',
    metricId: t.metricId, metricLabel: resolved.metric.nameShortRu || resolved.metric.nameRu,
    money, pct: resolved.metric.dataType === 'percent',
    templateId: t.id, rewardOverride: t.rewardEballs, tierBase: companyMedian,
    meta: { template: t.id, templateName: t.name, metricId: t.metricId, titleTemplate: t.titleTemplate,
      companyMedian, series, ...meta },
  };
  q.title = t.titleTemplate ? applyTitleTemplate(t.titleTemplate, q, endLabel) : buildTitle(q, endLabel);
  return q;
}

/** Личный ряд менеджера под конкретную встроенную категорию.
 *
 *  Дневных рядов в `PersonalStats` только один — продажи; поэтому у дневного
 *  шаблона на любой другой категории ряд пустой, и цель падает на пол (медиану
 *  компании за день) — то есть у всех одинаковая. Это осознанный компромисс, а
 *  не забытая ветка: тянуть ещё четыре дневных ряда в горячий запрос ради
 *  редкого шаблона дороже, чем честно поставить общую планку. */
function categorySeries(ps: PersonalStats, cat: QuestCategory, period: QuestPeriod): number[] {
  if (period === 'day') return cat === 'sales_count' ? ps.daily.cnt : [];
  const s = period === 'week' ? ps.weekly : ps.monthly;
  switch (cat) {
    case 'sales_count': return s.cnt;
    case 'sales_amount': return s.amt;
    case 'repeat_sales': return s.rep;
    case 'bookings_count': return s.bkg;
    case 'distinct_groups': return period === 'month' ? ps.monthly.grp : [];
    default: return [];
  }
}

/** Шаблон на встроенной категории: тот же расчёт, что у автокандидатов, но
 *  параметры (пол, потолок, способ, награда) задал владелец. Категории с
 *  подбором товарной группы (`group_sales`, `crosssell`) шаблоном не
 *  выдаются — им нужна пара «группа × клиенты», которую выбирает движок по
 *  данным менеджера, а не форма. */
function categoryTemplateQuest(
  t: QuestTemplate, period: QuestPeriod, endLabel: string,
  cmed: CompanyMedians, ps: PersonalStats,
): GenQuest | null {
  const cat = t.category;
  if (cat === null || cat === 'group_sales' || cat === 'crosssell' || cat === 'metric') return null;
  const series = categorySeries(ps, cat, period);
  const money = cat === 'sales_amount';
  const round = money ? (v: number) => Math.round(v / 10000) * 10000 : Math.round;
  const companyMedian = cmed[period]?.[cat] ?? 0;
  const { target, meta } = targetByMode(t, series, companyMedian, round);
  const q: GenQuest = {
    slot: period === 'day' ? 'day' : period === 'month' ? 'month' : 'week1',
    period, category: cat, target, targetGroup: null, pairFirst: null, title: '',
    money, templateId: t.id, rewardOverride: t.rewardEballs,
    meta: { template: t.id, templateName: t.name, titleTemplate: t.titleTemplate, companyMedian, ...meta },
  };
  q.title = t.titleTemplate ? applyTitleTemplate(t.titleTemplate, q, endLabel) : buildTitle(q, endLabel);
  return q;
}

/** Кандидаты квестов менеджера по слабостям (по приоритету). */
async function buildCandidates(
  mgr: number, period: QuestPeriod,
  tplCtx?: { db: Pool | PoolClient; xpLevel: number; today: string },
): Promise<GenQuest[]> {
  const ps = await fetchPersonal(mgr);
  const dept = await fetchDeptMedians(ps.deptId);
  const matrix = await fetchCrossSellMatrix();
  const out: { score: number; q: GenQuest }[] = [];
  const series = period === 'week' ? ps.weekly : ps.monthly;
  const endLabel = period === 'week' ? 'до воскресенья' : 'за месяц';

  // Повторка (вес 1.3)
  const repShare = (series.cnt.reduce((s, v) => s + v, 0) > 0)
    ? series.rep.reduce((s, v) => s + v, 0) / Math.max(series.cnt.reduce((s, v) => s + v, 0), 1) : 0;
  if (repShare < 0.7 * dept.repShare) {
    const t = targetFrom(series.rep.map(v => Math.max(v, 0)));
    const q: GenQuest = {
      slot: 'week1', period, category: 'repeat_sales', target: Math.max(t.target, 1),
      targetGroup: null, pairFirst: null, title: '', meta: { weakness: 'repeat', repShare, deptRepShare: dept.repShare, ...t },
    };
    q.title = buildTitle(q, endLabel);
    out.push({ score: (1 - repShare / Math.max(dept.repShare, 0.01)) * 1.3, q });
  }

  // Допродажа (вес 1.2): магистральные пары матрицы, где >= 3 клиентов с первой группой за 60 дн.
  // Только КРОСС-групповые пары (X→Y, Y≠X): самопереходы (газобетон→газобетон) в матрице
  // самые частые (клиент докупает то же), но квест «допродай ту же категорию» смысла не имеет —
  // правка Серёги 01.08: «с газобетона продают кровлю», самоповторы исключаем фильтром.
  const topPairs: { first: string; next: string }[] = [];
  for (const [from, f] of Object.entries(matrix.from)) {
    const best = Object.entries(f.to).filter(([to]) => to !== from).sort((a, b) => b[1] - a[1])[0];
    if (best && f.total >= 100) topPairs.push({ first: from, next: best[0] });
  }
  const pair = topPairs.find(p => (ps.pairClients.get(p.first) ?? 0) >= 3);
  if (pair) {
    const q: GenQuest = {
      slot: 'week1', period, category: 'crosssell', target: period === 'week' ? 1 : 2,
      targetGroup: pair.next, pairFirst: pair.first, title: '',
      meta: { weakness: 'crosssell', clientsWithFirst: ps.pairClients.get(pair.first) },
    };
    q.title = buildTitle(q, endLabel);
    out.push({ score: 0.5 * 1.2, q });
  }

  // Узкий ассортимент (вес 1.0): группа из его лидов, которую он мало продаёт.
  // Правка Серёги 01.08: Y НЕ должна быть топ-группой менеджера (её он и так гоняет) —
  // выбираем из групп, СМЕЖНЫХ его топовым по матрице переходов (to-группы от его топ-2
  // по продажам за 90 дн), исключая сами топы; вес смежности = частота перехода.
  // Достижимость как в дизайне (лиды/продажи Y у менеджера были) сохранена.
  // Fallback: если у менеджера нет выраженных топов (sales90 < 2) — старый отбор по лидам.
  const grpMed = median(ps.monthly.grp) ?? 0;
  if (grpMed < 0.7 * dept.grp) {
    const targetN = period === 'week' ? 2 : 3;
    const topsArr = [...ps.groups].sort((a, b) => b.sales90 - a.sales90)
      .slice(0, 2).filter(g => g.sales90 >= 2).map(g => g.group);
    const tops = new Set(topsArr);
    const adjWeight = new Map<string, number>();
    for (const t of tops) {
      const f = matrix.from[t];
      if (!f) continue;
      for (const [to, cnt] of Object.entries(f.to)) {
        if (to === t || tops.has(to)) continue;
        adjWeight.set(to, (adjWeight.get(to) ?? 0) + cnt);
      }
    }
    const achievable = (g: { sales90: number; weeklyRate: number; leads90: number }) =>
      g.sales90 >= 2 && g.weeklyRate < 4 && g.leads90 >= 3 * targetN;
    const cand = tops.size > 0
      ? ps.groups
          .filter(g => !tops.has(g.group) && adjWeight.has(g.group) && achievable(g))
          .sort((a, b) => (adjWeight.get(b.group)! - adjWeight.get(a.group)!) || (b.leads90 - a.leads90))[0]
      : ps.groups.filter(achievable).sort((a, b) => b.leads90 - a.leads90)[0];
    if (cand) {
      const q: GenQuest = {
        slot: 'week1', period, category: 'group_sales', target: targetN,
        targetGroup: cand.group, pairFirst: null, title: '',
        meta: { weakness: 'assortment', grpMed, deptGrp: dept.grp, leads90: cand.leads90, sales90: cand.sales90,
          adjacentTo: topsArr, adjWeight: adjWeight.get(cand.group) ?? null },
      };
      q.title = buildTitle(q, endLabel);
      out.push({ score: (1 - grpMed / Math.max(dept.grp, 1)) * 1.0, q });
    }
  }

  // Медианы компании — пол для целей (решение владельца 06.08.2026: «все
  // награды строить на превышении медианного значения»). Личный p75 сам по себе
  // у слабого менеджера опускается ниже общей медианы — пол не даёт цели стать
  // «повтори свой обычный результат», а потолок p90 не даёт ей стать
  // недосягаемой. Кэшируются в Redis на 6 часов, вызов дешёвый.
  const cmed = await fetchCompanyMedians().catch(() => ({} as CompanyMedians));

  // Брони (вес 1.25, задача 59). Владелец называет брони одним из ДВУХ главных
  // целевых действий, а до 07.08.2026 в квестах их не было ни одной штуки —
  // выдавать было нечего. Вес чуть ниже повторки (1.3) и чуть выше допродажи
  // (1.2): бронь — ведущее действие воронки, но не «умение», которого у
  // человека может не быть.
  //
  // База отдела — брони в пересчёте на неделю, личная — тот же ряд периодов,
  // что у продаж. Кандидат кладётся ВСЕГДА, а не только при слабости: базовый
  // балл 0.4 выше дефолтного продажного 0.3, поэтому у ровного менеджера два
  // недельных слота — это «брони + продажи», ровно два целевых действия.
  const bkgSeries = series.bkg;
  const deptBkg = period === 'week' ? dept.bkgWeek : dept.bkgWeek * (30 / 7);
  const persBkg = median(bkgSeries) ?? 0;
  const bkgT = targetFrom(bkgSeries, true, cmed[period]?.bookings_count ?? 0);
  const lastBkg = bkgSeries[bkgSeries.length - 1] ?? 0;
  const bkgSlump = persBkg > 0 && lastBkg < 0.8 * persBkg;
  const qBkg: GenQuest = {
    slot: 'week1', period, category: 'bookings_count', target: Math.max(bkgT.target, 1),
    targetGroup: null, pairFirst: null, title: '',
    meta: { weakness: 'bookings', persBkg, deptBkg, ...bkgT },
  };
  qBkg.title = buildTitle(qBkg, endLabel);
  const bkgWeak = deptBkg > 0 && persBkg < 0.8 * deptBkg
    ? (1 - persBkg / deptBkg) * 1.25 : 0;
  out.push({ score: Math.max(bkgWeak, bkgSlump ? 0.9 : 0.4), q: qBkg });

  // Просадка объёма / дефолтные продажные цели (вес 1.0).
  const cntT = targetFrom(series.cnt, true, cmed[period]?.sales_count ?? 0);
  const qCnt: GenQuest = {
    slot: 'week1', period, category: 'sales_count', target: cntT.target,
    targetGroup: null, pairFirst: null, title: '', meta: { weakness: 'volume', ...cntT },
  };
  qCnt.title = buildTitle(qCnt, endLabel);
  const lastCnt = series.cnt[series.cnt.length - 1] ?? 0;
  const slump = cntT.median > 0 && lastCnt < 0.8 * cntT.median;
  out.push({ score: slump ? 0.9 : 0.3, q: qCnt });

  const amtT = targetFrom(series.amt);
  const amtTarget = Math.max(Math.round(clamp(1.2 * amtT.median, 50000, Math.max(amtT.p90, 50000)) / 10000) * 10000, 50000);
  const qAmt: GenQuest = {
    slot: 'week1', period, category: 'sales_amount', target: amtTarget,
    targetGroup: null, pairFirst: null, title: '', meta: { weakness: 'volume_amount', ...amtT },
  };
  qAmt.title = buildTitle(qAmt, endLabel);
  out.push({ score: slump ? 0.85 : 0.25, q: qAmt });

  // Месячный бонус-вариант: разные группы (медиана + 2)
  if (period === 'month' && grpMed > 0) {
    const q: GenQuest = {
      slot: 'month', period, category: 'distinct_groups', target: Math.round(grpMed + 2),
      targetGroup: null, pairFirst: null, title: '', meta: { weakness: 'assortment_breadth', grpMed },
    };
    q.title = buildTitle(q, endLabel);
    out.push({ score: grpMed < dept.grp ? 0.6 : 0.2, q });
  }

  // Шаблоны конструктора (задача 60) — в тот же список кандидатов, сортировка
  // общая. Без tplCtx (старые вызовы/тесты) движок работает как раньше.
  if (tplCtx) {
    out.push(...await templateCandidates(
      tplCtx.db, mgr, period, { deptId: ps.deptId, xpLevel: tplCtx.xpLevel }, cmed, ps, tplCtx.today,
    ));
  }

  out.sort((a, b) => b.score - a.score);
  return out.map(x => x.q);
}

// ── XP-уровень менеджера (гейт легендарного тира) ────────────────────────────

async function fetchXpLevel(system: Pool | PoolClient, mgr: number): Promise<number> {
  try {
    const r = await system.query<{ t: string | null }>(
      `SELECT (SELECT coalesce(sum(total_xp),0) FROM xp_ledger WHERE bitrix_id=$1)
            + (SELECT coalesce(sum(reward_xp),0) FROM quests WHERE bitrix_id=$1 AND status='done') AS t`,
      [mgr],
    );
    const xp = Number(r.rows[0]?.t ?? 0);
    return xp < 500 ? 0 : Math.floor(Math.pow(xp / 500, 2 / 3));
  } catch { return 0; }
}

// ── генерация квестов менеджера (лениво при обращении + ночной тик) ──────────

export interface QuestRow {
  id: number; bitrixId: number; slot: QuestSlot; periodType: QuestPeriod;
  periodStart: string; periodEnd: string; category: QuestCategory;
  target: number; targetGroup: string | null; pairFirst: string | null;
  title: string; tier: QuestTier; rewardEballs: number; rewardXp: number;
  status: QuestStatus; progress: number; doneAt: string | null; rerollOf: number | null;
  /** category='metric': метрика каталога, по которой считается прогресс. */
  metricId: string | null;
  /** Из какого шаблона конструктора выдан (null — встроенный кандидат). */
  templateId: number | null;
}

// pg отдаёт date-колонки объектами Date (та же грабля, что с timestamptz в
// «Моих заказчиках») — нормализуем в YYYY-MM-DD, иначе строки дат ломают
// последующие SQL-параметры (пойман живьём: DecodeDateTime на $2).
function ymd(v: unknown): string {
  if (v instanceof Date) {
    // локальные геттеры — pg парсит date в локальную полночь, компоненты
    // совпадают с исходной датой при любом TZ процесса
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

function rowFromDb(r: Record<string, unknown>): QuestRow {
  return {
    id: Number(r.id), bitrixId: Number(r.bitrix_id), slot: r.slot as QuestSlot,
    periodType: r.period_type as QuestPeriod,
    periodStart: ymd(r.period_start), periodEnd: ymd(r.period_end),
    category: r.category as QuestCategory, target: Number(r.target),
    targetGroup: (r.target_group as string) ?? null, pairFirst: (r.pair_first as string) ?? null,
    title: String(r.title), tier: r.tier as QuestTier,
    rewardEballs: Number(r.reward_eballs), rewardXp: Number(r.reward_xp),
    status: r.status as QuestStatus, progress: Number(r.progress),
    doneAt: r.done_at ? new Date(r.done_at as string).toISOString() : null,
    rerollOf: r.reroll_of !== null && r.reroll_of !== undefined ? Number(r.reroll_of) : null,
    metricId: (r.metric_id as string) ?? null,
    templateId: r.template_id !== null && r.template_id !== undefined ? Number(r.template_id) : null,
  };
}

/** Тир, цель и награда квеста. Вынесено из insertQuest, потому что ровно то же
 *  нужно предпросмотру шаблона в конструкторе (задача 60) — а расходиться этим
 *  двум местам нельзя: предпросмотр обязан показывать то, что реально выдастся.
 *  МУТИРУЕТ g.title, если легендарный гейт прижал цель. */
function resolveTierAndReward(
  g: GenQuest, settings: QuestSettings, cm: CompanyMedians, xpLevel: number,
): { target: number; tier: QuestTier; reward: number; rewardXp: number; tierBase: number | null } {
  let target = g.target;
  // База тира: у встроенных категорий — медиана компании из CompanyMedians,
  // у квеста на произвольной метрике её там нет, шаблон приносит свою в tierBase.
  const tierBase = g.tierBase ?? cm[g.period]?.[g.category] ?? null;
  let tier = tierForTarget(g.category, g.period, target, cm, g.tierBase);
  // Легендарный — мягкий гейт: без титула Мастер+ (XP-уровень >= 15) цель
  // прижимается к верхней границе эпик-полосы (1.5× медианы компании).
  if (tier === 'legendary' && xpLevel < 15) {
    const base = tierBase ?? 1;
    target = (g.category === 'sales_amount' || g.money)
      ? Math.max(Math.round((1.5 * base) / 10000) * 10000, 50000)
      : Math.max(Math.floor(1.5 * base), 1);
    tier = tierForTarget(g.category, g.period, target, cm, g.tierBase);
    const endLabel = endLabelFor(g.period);
    const withTarget = { ...g, target };
    g.title = g.meta.titleTemplate
      ? applyTitleTemplate(String(g.meta.titleTemplate), withTarget, endLabel)
      : buildTitle(withTarget, endLabel);
  }
  const baseReward = g.period === 'day' ? settings.rewardDay : g.period === 'week' ? settings.rewardWeek : settings.rewardMonth;
  // Шаблон может задать награду жёстко (поле «Награда» в конструкторе) — тогда
  // тир остаётся только меткой сложности и на деньги не влияет.
  const reward = g.rewardOverride != null
    ? Math.max(0, Math.round(g.rewardOverride))
    : Math.max(1, Math.round(baseReward * settings.tierMult[tier]));
  return { target, tier, reward, rewardXp: Math.round(reward * settings.xpMult), tierBase };
}

async function insertQuest(system: Pool | PoolClient, mgr: number, g: GenQuest, slot: QuestSlot,
  bounds: { start: string; end: string }, settings: QuestSettings, cm: CompanyMedians,
  xpLevel: number, rerollOf: number | null = null): Promise<QuestRow | null> {
  const { target, tier, reward, rewardXp, tierBase } = resolveTierAndReward(g, settings, cm, xpLevel);
  const res = await system.query(
    `INSERT INTO quests (bitrix_id, slot, period_type, period_start, period_end, category,
       target, target_group, pair_first, title, tier, reward_eballs, reward_xp, reroll_of, meta,
       metric_id, template_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [mgr, slot, g.period, bounds.start, bounds.end, g.category, target, g.targetGroup, g.pairFirst,
      g.title, tier, reward, rewardXp, rerollOf,
      JSON.stringify({ ...g.meta, companyMedian: tierBase, xpLevel }),
      g.metricId ?? null, g.templateId ?? null],
  );
  return res.rows[0] ? rowFromDb(res.rows[0]) : null;
}

// ── предпросмотр шаблона для конструктора (задача 60) ────────────────────────

export interface TemplatePreviewRow {
  mgr: number; ok: boolean; title: string; target: number;
  tier: QuestTier; reward: number; rewardXp: number; note: string | null;
}

/** Что этот шаблон выдал бы прямо сейчас нескольким живым менеджерам.
 *
 *  Считается ТЕМ ЖЕ путём, что реальная выдача (кандидат → resolveTierAndReward),
 *  ничего не пишет в БД. Смысл — не дать владельцу включить шаблон, который
 *  ставит всем «продай 1» или, наоборот, легендарку на пустом месте: цифры
 *  видны до включения, а не по жалобам через неделю. */
export async function previewTemplate(
  system: Pool | PoolClient, t: QuestTemplate, mgrs: number[],
): Promise<TemplatePreviewRow[]> {
  const today = mskToday();
  const endLabel = endLabelFor(t.periodType);
  const [settings, cm] = await Promise.all([loadQuestSettings(system), fetchCompanyMedians()]);
  const out: TemplatePreviewRow[] = [];
  for (const mgr of mgrs) {
    const empty = { mgr, ok: false, title: '', target: 0, tier: 'white' as QuestTier, reward: 0, rewardXp: 0 };
    try {
      const ps = await fetchPersonal(mgr);
      const xpLevel = await fetchXpLevel(system, mgr);
      if (!matchesAudience(t, { deptId: ps.deptId, xpLevel, mgr })) {
        out.push({ ...empty, note: 'не подходит под аудиторию' });
        continue;
      }
      const g = t.kind === 'metric'
        ? await metricTemplateQuest(t, mgr, t.periodType, endLabel, today)
        : categoryTemplateQuest(t, t.periodType, endLabel, cm, ps);
      if (!g) {
        out.push({ ...empty, note: t.kind === 'metric'
          ? 'метрика не поддержана вычислителем'
          : 'эта категория шаблоном не выдаётся (нужен подбор товарной группы)' });
        continue;
      }
      const r = resolveTierAndReward(g, settings, cm, xpLevel);
      out.push({ mgr, ok: true, title: g.title, target: r.target, tier: r.tier,
        reward: r.reward, rewardXp: r.rewardXp, note: null });
    } catch (e) {
      out.push({ ...empty, note: e instanceof Error ? e.message : 'ошибка расчёта' });
    }
  }
  return out;
}

/** Догенерировать недостающие слоты менеджера на текущие периоды. Идемпотентно
 *  (уникальный индекс bitrix+slot+period_start). Дневной — только в рабочий день. */
export async function ensureQuests(system: Pool | PoolClient, mgr: number): Promise<void> {
  const today = mskToday();
  const [settings, cm] = await Promise.all([loadQuestSettings(system), fetchCompanyMedians()]);
  const have = await system.query<{ slot: string; period_start: string }>(
    `SELECT slot, period_start::text FROM quests
      WHERE bitrix_id = $1 AND status <> 'rerolled' AND slot <> 'extra'
        AND ((slot = 'day' AND period_start = $2)
          OR (slot IN ('week1','week2') AND period_start = $3)
          OR (slot = 'month' AND period_start = $4))`,
    [mgr, today, weekStart(today), monthStart(today)],
  );
  const haveSlots = new Set(have.rows.map(r => r.slot));
  const needWeek = !haveSlots.has('week1') || !haveSlots.has('week2');
  const needMonth = !haveSlots.has('month');
  const needDay = !haveSlots.has('day') && isWorkDay(today);
  if (!needWeek && !needMonth && !needDay) return;

  const xpLevel = await fetchXpLevel(system, mgr);
  const tplCtx = { db: system, xpLevel, today };
  if (needWeek) {
    const cands = await buildCandidates(mgr, 'week', tplCtx);
    const bounds = periodBounds('week', today);
    let idx = 0;
    for (const slot of ['week1', 'week2'] as const) {
      if (haveSlots.has(slot)) continue;
      // Не дублировать категорию во второй слот. У квестов из конструктора
      // категория у всех одна ('metric'), поэтому различаем по метрике —
      // иначе два разных шаблона считались бы одним и тем же квестом.
      const used = new Set((await system.query<{ category: string; metric_id: string | null }>(
        `SELECT category, metric_id FROM quests WHERE bitrix_id=$1 AND slot IN ('week1','week2') AND period_start=$2 AND status<>'rerolled'`,
        [mgr, bounds.start])).rows.map(r => r.category === 'metric' ? `metric:${r.metric_id}` : r.category));
      const key = (c: GenQuest) => c.category === 'metric' ? `metric:${c.metricId}` : c.category;
      let g = cands[idx];
      while (g && used.has(key(g))) { idx++; g = cands[idx]; }
      if (!g) break;
      idx++;
      await insertQuest(system, mgr, g, slot, bounds, settings, cm, xpLevel);
    }
  }
  if (needMonth) {
    const cands = await buildCandidates(mgr, 'month', tplCtx);
    const bounds = periodBounds('month', today);
    if (cands[0]) await insertQuest(system, mgr, cands[0], 'month', bounds, settings, cm, xpLevel);
  }
  if (needDay) {
    const bounds = periodBounds('day', today);
    // Дневной слот: если владелец завёл дневные шаблоны в конструкторе — берём
    // самый весомый подходящий; иначе прежнее поведение (продажи).
    const dayTpl = (await buildCandidates(mgr, 'day', tplCtx)).find(c => c.templateId != null);
    if (dayTpl) {
      await insertQuest(system, mgr, dayTpl, 'day', bounds, settings, cm, xpLevel);
    } else {
      // Цель от личного ряда, пол — дневная медиана компании.
      // Было: чёт/нечет дня → «личная цель» / жёстко target=1. Ротация давала
      // сильному продавцу халяву через день, а у непродающего вырождалась в
      // вечное «продай 1». Теперь цель считается всегда, а единица остаётся
      // только там, где личная дневная медиана нулевая — то есть у человека,
      // который продаёт реже чем через день, и для него это честный вызов.
      const ps = await fetchPersonal(mgr);
      const t = targetFrom(ps.daily.cnt, false, cm.day?.sales_count ?? 0);
      const g: GenQuest = (median(ps.daily.cnt) ?? 0) >= 1
        ? { slot: 'day', period: 'day', category: 'sales_count', target: Math.max(t.target, 1), targetGroup: null, pairFirst: null, title: '', meta: { rotation: 'count', ...t } }
        : { slot: 'day', period: 'day', category: 'sales_count', target: 1, targetGroup: null, pairFirst: null, title: '', meta: { rotation: 'simple' } };
      g.title = buildTitle({ ...g }, 'сегодня');
      await insertQuest(system, mgr, g, 'day', bounds, settings, cm, xpLevel);
    }
  }
}

// ── прогресс и автозачёт ─────────────────────────────────────────────────────

interface PeriodDeal {
  soldDay: string; amount: number; isRepeat: boolean; grps: string[]; prevGrps: string[] | null;
}

/** Факты периода: проданные сделки (sold_at) и брони (reserved_at).
 *  Брони — отдельный ряд, а не флаг на сделке: одна и та же сделка может быть
 *  забронирована в одном периоде, а продана в другом (или не продана вовсе),
 *  и оба события засчитываются каждое в свой квест. Определение брони —
 *  метрика каталога `reservations_count`: заполнен `reserved_at`, без фильтра
 *  по воронке. */
interface PeriodFacts { sold: PeriodDeal[]; booked: { day: string }[] }

async function fetchPeriodDeals(mgr: number, fromDay: string): Promise<PeriodFacts> {
  const res = await analyticsDb().query<{
    sold_day: string; amount: string; is_repeat: boolean; grps: string[] | null; prev_grps: string[] | null;
  }>(`
    WITH seq AS (
      SELECT d.deal_id, d.current_manager_id, d.sold_at, coalesce(d.amount,0) AS amount,
             coalesce(f.is_repeat,false) AS is_repeat, dg.grps,
             LAG(dg.grps) OVER (PARTITION BY (${CLIENT_KEY_CASE_SQL})
                                ORDER BY d.sold_at, d.deal_id) AS prev_grps
      FROM sa.deals d
      LEFT JOIN sa.funnels f ON f.id = d.funnel_id
      CROSS JOIN LATERAL (
        SELECT array(SELECT DISTINCT (p->>'head_group_name') FROM jsonb_array_elements(d.products) p
                     WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
                       AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)') AS grps
      ) dg
      WHERE d.sold_at IS NOT NULL AND d.funnel_id IN (0,1,2,3)
        AND (${CLIENT_KEY_CASE_SQL}) IS NOT NULL
    )
    SELECT (sold_at AT TIME ZONE '${MSK}')::date::text AS sold_day, amount::text, is_repeat, grps, prev_grps
    FROM seq WHERE current_manager_id = $1 AND (sold_at AT TIME ZONE '${MSK}')::date >= $2::date
    UNION ALL
    -- сделки без клиента (контакт/компания пустые) — идут в счёт/сумму, но без допродаж
    SELECT (d.sold_at AT TIME ZONE '${MSK}')::date::text, coalesce(d.amount,0)::text, coalesce(f.is_repeat,false),
           array(SELECT DISTINCT (p->>'head_group_name') FROM jsonb_array_elements(d.products) p
                 WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
                   AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)'), NULL
    FROM sa.deals d LEFT JOIN sa.funnels f ON f.id = d.funnel_id
    WHERE d.sold_at IS NOT NULL AND d.current_manager_id = $1
      AND (d.sold_at AT TIME ZONE '${MSK}')::date >= $2::date
      AND NOT (d.funnel_id IN (0,1,2,3) AND (${CLIENT_KEY_CASE_SQL}) IS NOT NULL)
  `, [mgr, fromDay]);
  const bkg = await analyticsDb().query<{ day: string }>(`
    SELECT (d.reserved_at AT TIME ZONE '${MSK}')::date::text AS day
    FROM sa.deals d
    WHERE d.reserved_at IS NOT NULL AND d.current_manager_id = $1
      AND (d.reserved_at AT TIME ZONE '${MSK}')::date >= $2::date
  `, [mgr, fromDay]);
  return {
    sold: res.rows.map(r => ({
      soldDay: r.sold_day, amount: Number(r.amount), isRepeat: r.is_repeat,
      grps: r.grps ?? [], prevGrps: r.prev_grps,
    })),
    booked: bkg.rows.map(r => ({ day: r.day })),
  };
}

async function questProgress(q: QuestRow, facts: PeriodFacts): Promise<number> {
  // Квест из конструктора (задача 60): считает универсальный вычислитель по
  // metric_id, записанному в самой строке квеста. Именно из строки, а не из
  // шаблона: шаблон могли отредактировать или выключить, а уже выданный квест
  // обязан дожить свой период с той метрикой, под которую человеку его дали.
  if (q.category === 'metric') {
    return q.metricId ? metricQuestProgress(q.metricId, q.bitrixId, q.periodStart, q.periodEnd) : 0;
  }
  const inPeriod = facts.sold.filter(d => d.soldDay >= q.periodStart && d.soldDay <= q.periodEnd);
  switch (q.category) {
    case 'sales_count': return inPeriod.length;
    case 'bookings_count':
      return facts.booked.filter(b => b.day >= q.periodStart && b.day <= q.periodEnd).length;
    case 'sales_amount': return inPeriod.reduce((s, d) => s + d.amount, 0);
    case 'repeat_sales': return inPeriod.filter(d => d.isRepeat).length;
    case 'group_sales': return inPeriod.filter(d => q.targetGroup !== null && d.grps.includes(q.targetGroup)).length;
    case 'distinct_groups': return new Set(inPeriod.flatMap(d => d.grps)).size;
    case 'crosssell':
      return inPeriod.filter(d =>
        q.targetGroup !== null && d.grps.includes(q.targetGroup)
        && q.pairFirst !== null && (d.prevGrps ?? []).includes(q.pairFirst)).length;
  }
}

// Слоты SLOT_LABELS для читаемого текста пуша (задача 2759, п.6) — держим
// маленький локальный словарь, не тянем UI-константы из features/quests/ui.
const SLOT_LABELS_RU: Record<string, string> = {
  day: 'Дневной', week1: 'Недельный', week2: 'Недельный', month: 'Месячный', extra: 'Доп.',
};

/** Переводит просроченные активные квесты в failed и шлёт пуш «Аналитиком»
 *  (задача 2759, п.6: «провалил — ничего не теряешь», просто уведомление, без
 *  штрафов). Global UPDATE (не по конкретному mgr) — вызывается и из questTick
 *  (ночной прогон), и из refreshQuests (открыл таб «Квесты») — идемпотентно:
 *  WHERE status='active' ловит каждую строку РОВНО один раз, кто бы первый ни
 *  зашёл, поэтому безопасно звать из обоих мест без риска задвоить пуш. */
async function expireOverdueQuests(system: Pool, today: string): Promise<void> {
  const failed = await system.query<{ bitrix_id: number; slot: string; title: string }>(
    `UPDATE quests SET status='failed' WHERE status='active' AND period_end < $1
     RETURNING bitrix_id::int AS bitrix_id, slot, title`,
    [today],
  );
  if (failed.rows.length === 0) return;
  const byMgr = new Map<number, { slot: string; title: string }[]>();
  for (const r of failed.rows) (byMgr.get(r.bitrix_id) ?? byMgr.set(r.bitrix_id, []).get(r.bitrix_id)!).push(r);
  for (const [mgr, list] of byMgr) {
    if (list.length <= 4) {
      for (const q of list) {
        void pushViaAnalitik(mgr, `⏳ Квест сгорел: ${q.title}`,
          `${SLOT_LABELS_RU[q.slot] ?? q.slot} слот не выполнен в срок — ничего не списано, квест просто исчез.`);
      }
    } else {
      void pushViaAnalitik(mgr, `⏳ Сгорело ${list.length} квестов`,
        `${list.slice(0, 6).map(q => q.title).join(', ')}${list.length > 6 ? '…' : ''} — ничего не списано.`);
    }
  }
}

/** Пересчёт прогресса активных квестов менеджера + автозачёт выполненных +
 *  провал просроченных. Возвращает свежие квесты текущих периодов + историю.
 *
 *  ПОРЯДОК ОПЕРАЦИЙ ВАЖЕН (баг найден 06.08.2026). Раньше просроченные гасились
 *  ПЕРВЫМИ — до пересчёта прогресса. Ночной тик идёт в 03:00, то есть вчерашний
 *  дневной квест к этому моменту уже `period_end < today` и улетал в `failed`,
 *  так и не узнав, что человек вчера продал. Замер на живых данных: из 174
 *  случаев «продажа в день квеста реально была» закрылось 11. Закрыться квест
 *  мог только если человек сам открыл вкладку до полуночи.
 *  Теперь: сперва считаем прогресс по ВСЕМ активным (включая просроченные —
 *  questProgress фильтрует сделки по границам периода квеста, так что задним
 *  числом считается корректно), и только потом гасим то, что не дотянуло.
 *
 *  `expire: false` — для тика, который крутит цикл по всем менеджерам: гашение
 *  глобальное (один UPDATE на всю таблицу), поэтому внутри цикла оно убило бы
 *  чужие квесты до того, как до них дойдёт очередь считать прогресс. Тик гасит
 *  сам, один раз, в самом конце. */
export async function refreshQuests(
  system: Pool, mgr: number, opts: { expire?: boolean } = {},
): Promise<{ current: QuestRow[]; history: QuestRow[] }> {
  const today = mskToday();
  await ensureQuests(system, mgr);

  const act = await system.query(`SELECT * FROM quests WHERE bitrix_id=$1 AND status='active'`, [mgr]);
  const active = act.rows.map(rowFromDb);
  if (active.length > 0) {
    const minStart = active.map(q => q.periodStart).sort()[0];
    const facts = await fetchPeriodDeals(mgr, minStart);
    for (const q of active) {
      const progress = await questProgress(q, facts);
      if (progress >= q.target) {
        await completeQuest(system, q, progress);
      } else if (progress !== q.progress) {
        await system.query(`UPDATE quests SET progress=$2 WHERE id=$1 AND status='active'`, [q.id, progress]);
      }
    }
  }
  // Просроченные и не дотянувшие — в failed (молча по деньгам, ничего не
  // списывается; с пушем — задача 2759). Только ПОСЛЕ пересчёта, см. коммент выше.
  if (opts.expire !== false) await expireOverdueQuests(system, today);
  const cur = await system.query(
    `SELECT * FROM quests WHERE bitrix_id=$1 AND status<>'rerolled' AND period_end >= $2 ORDER BY
       CASE slot WHEN 'day' THEN 0 WHEN 'week1' THEN 1 WHEN 'week2' THEN 2 WHEN 'month' THEN 3 ELSE 4 END`,
    [mgr, today],
  );
  const hist = await system.query(
    `SELECT * FROM quests WHERE bitrix_id=$1 AND status IN ('done','failed') AND period_end < $2
      AND period_end >= $2::date - 56 ORDER BY period_end DESC, id DESC LIMIT 60`,
    [mgr, today],
  );
  return { current: cur.rows.map(rowFromDb), history: hist.rows.map(rowFromDb) };
}

/** Зачёт квеста: идемпотентно (status-гард), начисление в леджер (source='quest'),
 *  уведомление колокольчиком + пуш Битрикс-ботом «Аналитик». */
async function completeQuest(system: Pool, q: QuestRow, progress: number): Promise<void> {
  const client = await system.connect();
  let completed = false;
  let loot: LootDrop | null = null;
  const currencyName = await getCurrencyName(system);
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE quests SET status='done', progress=$2, done_at=now() WHERE id=$1 AND status='active' RETURNING id`,
      [q.id, progress],
    );
    if (upd.rows.length > 0) {
      const led = await client.query<{ id: string }>(
        `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award, currency, source, comment)
         VALUES ($1, NULL, NULL, $2, $2, 'EBALL', 'quest', $3) RETURNING id`,
        [q.bitrixId, q.rewardEballs, `Квест: ${q.title}`],
      );
      loot = await rollLoot(client, q.bitrixId, q.tier);
      await client.query(`UPDATE quests SET coin_ledger_id=$2, meta = meta || $3::jsonb WHERE id=$1`,
        [q.id, Number(led.rows[0].id), JSON.stringify({ loot })]);
      await createNotification(client, {
        bitrixId: q.bitrixId, type: 'quest_done',
        title: `Квест выполнен: ${q.title}`,
        body: `+${q.rewardEballs} ${currencyName} и +${q.rewardXp} XP.${loot ? ` Лутдроп: ${loot.itemName}!` : ''} Так держать!`,
      });
      completed = true;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (completed) {
    void pushViaAnalitik(q.bitrixId, `🗺️ Квест выполнен: ${q.title}`,
      `+${q.rewardEballs} ${currencyName}, +${q.rewardXp} XP${loot ? `. 🎁 Лутдроп: ${loot.itemName}!` : ''}`);
  }
}

// ── реролл и докупка ─────────────────────────────────────────────────────────

export async function rerollQuest(
  system: Pool, mgr: number, questId: number, actorLogin: string,
  pinActor: PinActorCtx, pin: unknown,
): Promise<PinGatedResult<QuestRow>> {
  const settings = await loadQuestSettings(system);
  const r = await system.query(`SELECT * FROM quests WHERE id=$1 AND bitrix_id=$2`, [questId, mgr]);
  if (r.rows.length === 0) return { ok: false, error: 'Квест не найден' };
  const q = rowFromDb(r.rows[0]);
  if (q.status !== 'active') return { ok: false, error: 'Заменить можно только активный квест' };
  if (q.rerollOf !== null) return { ok: false, error: 'Этот квест уже был заменой — второй реролл нельзя' };
  const already = await system.query(`SELECT 1 FROM quests WHERE reroll_of=$1`, [q.id]);
  if (already.rows.length > 0) return { ok: false, error: 'Квест уже заменяли' };
  const price = q.periodType === 'day' ? settings.rerollDay : q.periodType === 'week' ? settings.rerollWeek : settings.rerollMonth;

  const bal = await system.query<{ b: string }>(`SELECT coalesce(balance,0)::text AS b FROM badge_coin_balances WHERE bitrix_id=$1`, [mgr]);
  if (Number(bal.rows[0]?.b ?? 0) < price) return { ok: false, error: `Не хватает ${await getCurrencyName(system)} (нужно ${price})` };

  // Личный порог (задача #2995) — считается и проверяется ДО открытия денежной
  // транзакции ниже: verifyPin коммитит инкремент неудачи в СВОЁЙ транзакции.
  const need = await spendPinRequirement(system, mgr, price);
  let pinEventId: number | null = null;
  if (need.required) {
    const verified = await verifyPin(system, pinActor, pin, { operation: 'quest_reroll', targetRef: String(questId), amount: price, currency: 'EBALL' });
    if (!verified.ok) return { ok: false, error: verified.error, status: verified.status };
    pinEventId = verified.pinEventId;
  }

  // Новый квест ТОГО ЖЕ тира (схема v2): генерим кандидатов, берём первый
  // другой категории с тем же расчётным тиром; если такого нет — ближайший.
  const cm = await fetchCompanyMedians();
  const xpLevel = await fetchXpLevel(system, mgr);
  const cands = (q.periodType === 'day')
    ? [] : await buildCandidates(mgr, q.periodType, { db: system, xpLevel, today: mskToday() });
  let pick: GenQuest | null = null;
  for (const c of cands) {
    // Тот же квест не предлагаем: для встроенных сравниваем категорию и группу,
    // для квестов конструктора — метрику (категория у всех них одна).
    if (c.category === q.category && c.targetGroup === q.targetGroup && c.metricId === q.metricId) continue;
    if (tierForTarget(c.category, c.period, c.target, cm, c.tierBase) === q.tier) { pick = c; break; }
  }
  if (!pick) pick = cands.find(c => c.category !== q.category) ?? null;
  if (q.periodType === 'day' || !pick) {
    // дневной (или нет альтернатив): та же категория, счёт/сумма наоборот
    const ps = await fetchPersonal(mgr);
    const t = targetFrom(q.periodType === 'day' ? ps.daily.cnt : (q.periodType === 'week' ? ps.weekly : ps.monthly).amt, false);
    pick = q.category === 'sales_amount'
      ? { slot: q.slot, period: q.periodType, category: 'sales_count', target: Math.max(t.target, 1), targetGroup: null, pairFirst: null, title: '', meta: { reroll: true } }
      : { slot: q.slot, period: q.periodType, category: 'sales_amount', target: Math.max(Math.round((1.2 * (median((q.periodType === 'week' ? ps.weekly : q.periodType === 'month' ? ps.monthly : { amt: [100000] as number[] } as never).amt as number[]) ?? 100000)) / 10000) * 10000, 50000), targetGroup: null, pairFirst: null, title: '', meta: { reroll: true } };
    pick.title = buildTitle(pick, q.periodType === 'day' ? 'сегодня' : q.periodType === 'week' ? 'до воскресенья' : 'за месяц');
  }

  const client = await system.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award, currency, source, actor_login, comment, pin_event_id)
       VALUES ($1, NULL, NULL, $2, $2, 'EBALL', 'quest_reroll', $3, $4, $5)`,
      [mgr, -price, actorLogin, `Замена квеста: ${q.title}`, pinEventId],
    );
    await client.query(`UPDATE quests SET status='rerolled' WHERE id=$1`, [q.id]);
    const inserted = await insertQuest(client, mgr, pick, q.slot,
      { start: q.periodStart, end: q.periodEnd }, settings, cm, xpLevel, q.id);
    await client.query('COMMIT');
    if (!inserted) return { ok: false, error: 'Не удалось сгенерировать замену' };
    return { ok: true, quest: inserted };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function buyExtraQuest(
  system: Pool, mgr: number, actorLogin: string,
  pinActor: PinActorCtx, pin: unknown,
): Promise<PinGatedResult<QuestRow>> {
  const settings = await loadQuestSettings(system);
  const today = mskToday();
  if (!isWorkDay(today)) return { ok: false, error: 'Доп. квест доступен только в рабочий день' };
  const day = await system.query(
    `SELECT status FROM quests WHERE bitrix_id=$1 AND slot='day' AND period_start=$2 AND status<>'rerolled'`,
    [mgr, today],
  );
  if (!day.rows.some(r => r.status === 'done')) {
    return { ok: false, error: 'Сначала выполните дневной квест' };
  }
  const todayExtra = await system.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM quests WHERE bitrix_id=$1 AND slot='extra' AND period_start=$2`,
    [mgr, today],
  );
  if (Number(todayExtra.rows[0].c) >= 1) return { ok: false, error: 'Максимум 1 доп. квест в день' };
  const weekExtra = await system.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM quests WHERE bitrix_id=$1 AND slot='extra' AND period_start >= $2`,
    [mgr, weekStart(today)],
  );
  const price = settings.extraDay * Math.pow(2, Number(weekExtra.rows[0].c)); // ×2 за каждый следующий в неделе
  const bal = await system.query<{ b: string }>(`SELECT coalesce(balance,0)::text AS b FROM badge_coin_balances WHERE bitrix_id=$1`, [mgr]);
  if (Number(bal.rows[0]?.b ?? 0) < price) return { ok: false, error: `Не хватает ${await getCurrencyName(system)} (нужно ${price})` };

  const need = await spendPinRequirement(system, mgr, price);
  let pinEventId: number | null = null;
  if (need.required) {
    const verified = await verifyPin(system, pinActor, pin, { operation: 'quest_extra', amount: price, currency: 'EBALL' });
    if (!verified.ok) return { ok: false, error: verified.error, status: verified.status };
    pinEventId = verified.pinEventId;
  }

  const cm = await fetchCompanyMedians();
  const xpLevel = await fetchXpLevel(system, mgr);
  const ps = await fetchPersonal(mgr);
  // Доп. дневной: сумма ≈ 1/5 недельной медианы (дневная доля), пол 50 тыс.
  const dayAmt = Math.max(Math.round(((median(ps.weekly.amt) ?? 250000) / 5) / 10000) * 10000, 50000);
  const g: GenQuest = {
    slot: 'extra', period: 'day', category: 'sales_amount', target: dayAmt,
    targetGroup: null, pairFirst: null, title: '', meta: { extra: true, weeklyAmtMedian: median(ps.weekly.amt) },
  };
  g.title = buildTitle(g, 'сегодня');
  const client = await system.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award, currency, source, actor_login, comment, pin_event_id)
       VALUES ($1, NULL, NULL, $2, $2, 'EBALL', 'quest_extra', $3, 'Доп. дневной квест', $4)`,
      [mgr, -price, actorLogin, pinEventId],
    );
    const inserted = await insertQuest(client, mgr, g, 'extra', { start: today, end: today }, settings, cm, xpLevel);
    await client.query('COMMIT');
    if (!inserted) return { ok: false, error: 'Не удалось сгенерировать квест' };
    return { ok: true, quest: inserted };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}


// ── лутдроп (общий для квестов и контрактов, миграция 126) ───────────────────

export interface LootDrop { itemId: number; itemName: string }

/** Серверный ролл лута по тиру (в транзакции зачёта): предмет магазина в
 *  инвентарь (механика гачи: owned, TTL предмета). null = не выпало.
 *  Легендарный тир — шанс 100% (гарантированная шмотка). */
export async function rollLoot(client: PoolClient, bitrixId: number, tier: QuestTier): Promise<LootDrop | null> {
  try {
    const lt = await client.query<{ loot_table: Record<string, { chance: number; items: number[] }> }>(
      `SELECT loot_table FROM quest_settings WHERE id=1`,
    );
    const entry = lt.rows[0]?.loot_table?.[tier];
    if (!entry || !Array.isArray(entry.items) || entry.items.length === 0) return null;
    if (Math.random() >= Number(entry.chance)) return null;
    const itemId = entry.items[Math.floor(Math.random() * entry.items.length)];
    const item = await client.query<{ id: number; name: string; ttl_months: number }>(
      `SELECT id, name, ttl_months FROM shop_items WHERE id=$1 AND enabled`, [itemId],
    );
    if (item.rows.length === 0) return null;
    await client.query(
      `INSERT INTO inventory_items (bitrix_id, shop_item_id, item_name, price_paid, currency, status, expires_at)
       VALUES ($1, $2, $3, 1, 'EBALL', 'owned', now() + make_interval(months => $4))`,
      [bitrixId, item.rows[0].id, item.rows[0].name, item.rows[0].ttl_months],
    );
    return { itemId: item.rows[0].id, itemName: item.rows[0].name };
  } catch { return null; } // до миграции 126 колонки loot_table нет
}

// ── ночной тик: экспирация, генерация всем, автозачёт, квест-бейджи ──────────

export interface QuestAwardRow {
  bitrixId: number; badgeKey: string; tier: null; periodType: 'week' | 'month' | null;
  periodDate: string | null; value: number | null; counter?: boolean;
}

export async function questTick(system: Pool, activeManagerIds: number[]): Promise<{ awards: QuestAwardRow[]; generatedFor: number }> {
  const today = mskToday();
  // Доска контрактов (миграция 126): пул недели + прогресс/дедлайны взятых.
  try {
    const { ensureContractPool, refreshContracts } = await import('./contracts');
    await ensureContractPool(system);
    const owners = await system.query<{ b: number }>(`SELECT DISTINCT taken_by::int AS b FROM quest_contracts WHERE status='taken'`);
    for (const o of owners.rows) await refreshContracts(system, o.b).catch(() => {});
  } catch (e) {
    console.warn('[quests] контракты в тике пропущены:', e instanceof Error ? e.message : e);
  }
  let generatedFor = 0;
  for (const mgr of activeManagerIds) {
    try {
      // expire:false — гасим ОДИН раз после цикла, иначе первый же менеджер
      // своим глобальным UPDATE похоронит просрочку остальных до их пересчёта.
      await refreshQuests(system, mgr, { expire: false }); // генерация + прогресс + автозачёт
      generatedFor++;
    } catch (e) {
      console.warn(`[quests] тик менеджера ${mgr} упал:`, e instanceof Error ? e.message : e);
    }
  }
  // Всё, что не дотянуло до цели за свой период, — в failed. Строго после
  // пересчёта всех менеджеров.
  await expireOverdueQuests(system, today);

  // Квест-бейджи (активированы миграцией 125):
  const awards: QuestAwardRow[] = [];
  const all = await system.query(
    `SELECT bitrix_id::int AS b, slot, period_type, period_start::text AS ps, period_end::text AS pe, status
       FROM quests WHERE status IN ('done','failed') ORDER BY period_end, id`,
  );
  const byMgr = new Map<number, { slot: string; pt: string; ps: string; pe: string; st: string }[]>();
  for (const r of all.rows as { b: number; slot: string; period_type: string; ps: string; pe: string; status: string }[]) {
    (byMgr.get(r.b) ?? byMgr.set(r.b, []).get(r.b)!).push({ slot: r.slot, pt: r.period_type, ps: r.ps, pe: r.pe, st: r.status });
  }
  for (const [mgr, list] of byMgr) {
    // «Квестоман»: 10 выполненных подряд без провала (хронология по period_end)
    let run = 0; let streaks = 0;
    for (const q of list) {
      if (q.st === 'done') { run++; if (run > 0 && run % 10 === 0) streaks++; }
      else run = 0;
    }
    if (streaks > 0) awards.push({ bitrixId: mgr, badgeKey: 'quest_streak_10', tier: null, periodType: null, periodDate: null, value: streaks, counter: true });
    // «Пятилетка за неделю»: все недельные квесты недели закрыты (оба слота)
    const weeks = new Map<string, { done: number; total: number }>();
    for (const q of list.filter(x => x.pt === 'week')) {
      const w = weeks.get(q.ps) ?? weeks.set(q.ps, { done: 0, total: 0 }).get(q.ps)!;
      w.total++; if (q.st === 'done') w.done++;
    }
    for (const [ws, w] of weeks) {
      if (w.total >= 2 && w.done === w.total) {
        awards.push({ bitrixId: mgr, badgeKey: 'quest_week_all', tier: null, periodType: 'week', periodDate: ws, value: w.total });
      }
    }
    // «Без пропусков»: месяц без проваленного дневного (и хотя бы 10 дневных было)
    const months = new Map<string, { failed: number; total: number }>();
    for (const q of list.filter(x => x.pt === 'day')) {
      const mk = q.ps.slice(0, 7) + '-01';
      const m = months.get(mk) ?? months.set(mk, { failed: 0, total: 0 }).get(mk)!;
      m.total++; if (q.st === 'failed') m.failed++;
    }
    for (const [ms, m] of months) {
      if (m.total >= 10 && m.failed === 0 && ms < monthStart(today)) {
        awards.push({ bitrixId: mgr, badgeKey: 'quest_month_daily', tier: null, periodType: 'month', periodDate: ms, value: m.total });
      }
    }
  }
  return { awards, generatedFor };
}
