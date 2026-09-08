// «Телевизоры» — фид экрана: цифры «сегодня» по менеджерам выбранных отделов.
//
// Источники — те же, что у план/факт-полосы ЛК (features/manager-card/engine/planFact.ts),
// чтобы телевизор и кабинет не спорили:
//   • факты — каталог метрик через buildCollectedSQL (продажи перв.+повт. по sold_at,
//     брони по reserved_at), группировка по current_manager_id;
//   • план дня — lib/plans/dailyPlan::computePeriodPlanByLogin(today,today,today)
//     (режим деления плана учтён там);
//   • состав отделов — resolveManagersForDepartments (ручная org_resolved_hierarchy);
//   • аватары — bulk из кэша manager_avatars, недостающие догружаются в фоне.
// Кэш фида — Redis 20 с на экран: десять телевизоров одного отдела = один запрос.

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { computePeriodPlanByLogin } from '@/lib/plans/dailyPlan';
import type { RosterManager } from '@/lib/org/teamRoster';
import { buildTvTree, deptChains, loadActiveManagers, managersOfNode, type TvNode } from './orgTree';
import { getManagerAvatarUrl } from '@/lib/bitrix/managerAvatar';
import { cached } from '@/lib/cache/redis';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { isPlaceholderName, type TvFeedCard, type TvFeedManager, type TvFeedOk, type TvFeedSale, type TvFeedSlide, type TvScreen } from '../shared';
import { activeMessagesForScreen } from './store';

const TZ = 'Europe/Moscow';
const FEED_TTL_SEC = 20;

const FACT_IDS = [
  'primary_sales_count', 'repeat_sales_count', 'primary_sales_amount', 'repeat_sales_amount',
  'reservations_count', 'reservations_amount',
  // заявки за день (created_at) — для «активного менеджера» (правка владельца 08.09)
  'primary_deals_count', 'repeat_deals_count',
] as const;
export type FactId = (typeof FACT_IDS)[number];

export function mskTodayStr(): string {
  const now = toZonedTime(new Date(), TZ);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function mskMidnightIso(dateStr: string): string {
  return fromZonedTime(`${dateStr} 00:00:00`, TZ).toISOString();
}
export function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function fetchFactsByManager(idsNum: number[], fromIso: string, toExclIso: string): Promise<Map<string, Record<FactId, number>>> {
  const out = new Map<string, Record<FactId, number>>();
  if (idsNum.length === 0) return out;
  const all = await loadMetrics();
  const metrics = all.filter(m => (FACT_IDS as readonly string[]).includes(m.id));
  const sql = buildCollectedSQL(metrics, {
    idExpr: 'd.current_manager_id::text',
    groupBy: 'GROUP BY 1',
    notNullWhere: `d.current_manager_id IN (${idsNum.join(',')})`,
  });
  if (!sql) return out;
  const res = await analyticsDb().query<Record<string, unknown>>(sql, [fromIso, toExclIso]);
  for (const row of res.rows) {
    const id = String(row.dimension_id);
    const rec = Object.fromEntries(FACT_IDS.map(k => [k, 0])) as Record<FactId, number>;
    for (const k of FACT_IDS) {
      const v = row[k];
      rec[k] = v !== null && v !== undefined ? Number(v) : 0;
    }
    out.set(id, rec);
  }
  return out;
}

/** Продажи сегодня списком — для событий «мувик на продажу» (клиент сравнивает id). */
async function fetchTodaySales(idsNum: number[], fromIso: string, toExclIso: string, names: Map<string, string>): Promise<TvFeedSale[]> {
  if (idsNum.length === 0) return [];
  const res = await analyticsDb().query<{ deal_id: string; manager_id: string; amount: string | null; sold_at: string }>(
    `SELECT deal_id::text AS deal_id, current_manager_id::text AS manager_id, amount, sold_at
       FROM deals
      WHERE sold_at >= $1 AND sold_at < $2 AND current_manager_id IN (${idsNum.join(',')})
      ORDER BY sold_at DESC
      LIMIT 100`,
    [fromIso, toExclIso],
  );
  return res.rows.map(r => ({
    id: r.deal_id, managerId: r.manager_id, managerName: names.get(r.manager_id) ?? '',
    amount: Number(r.amount ?? 0), at: new Date(r.sold_at).toISOString(),
  }));
}

// Аватары: bulk из кэша; у кого нет/протух — догружаем в фоне по одному (Битрикс),
// не задерживая ответ телевизору. Не чаще раза в 10 минут на менеджера.
const _avatarKick = new Map<string, number>();
export async function fetchAvatars(ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  try {
    const res = await systemDb().query<{ bitrix_user_id: string; avatar_url: string | null; synced_at: string }>(
      'SELECT bitrix_user_id, avatar_url, synced_at FROM manager_avatars WHERE bitrix_user_id = ANY($1)',
      [ids],
    );
    const fresh = new Set<string>();
    for (const r of res.rows) {
      out.set(r.bitrix_user_id, r.avatar_url);
      if (Date.now() - new Date(r.synced_at).getTime() < 7 * 24 * 3600 * 1000) fresh.add(r.bitrix_user_id);
    }
    const missing = ids.filter(id => !fresh.has(id));
    const now = Date.now();
    for (const id of missing.slice(0, 5)) {
      if (now - (_avatarKick.get(id) ?? 0) < 10 * 60 * 1000) continue;
      _avatarKick.set(id, now);
      void getManagerAvatarUrl(id).catch(() => null);
    }
  } catch {
    // таблицы может не быть — телевизор живёт с инициалами
  }
  return out;
}

/** Начало окна «последние N рабочих дней» (Пн–Пт, без учёта праздников — для
 *  вопроса «жив ли аккаунт» этого достаточно), МСК-полночь в ISO. */
export function workingDaysBackIso(todayStr: string, n: number): string {
  let d = new Date(`${todayStr}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return mskMidnightIso(d.toISOString().slice(0, 10));
}

/** Менеджеры с продажей или бронью в окне [fromIso, toExclIso). */
export async function recentlyActiveIds(idsNum: number[], fromIso: string, toExclIso: string): Promise<Set<string>> {
  if (idsNum.length === 0) return new Set();
  const res = await analyticsDb().query<{ manager_id: string }>(
    `SELECT DISTINCT current_manager_id::text AS manager_id
       FROM deals
      WHERE current_manager_id IN (${idsNum.join(',')})
        AND ((sold_at >= $1 AND sold_at < $2) OR (reserved_at >= $1 AND reserved_at < $2))`,
    [fromIso, toExclIso],
  );
  return new Set(res.rows.map(r => r.manager_id));
}

/**
 * Кого показывать на плитках (правило владельца 07.09, после замечания про
 * manager2014): нормальное ФИО — показываем; имя-заглушка (свободный слот Битрикса,
 * ~76 из 431 активных строк org_resolved_hierarchy) — только если были продажи или
 * брони за последние 5 рабочих дней (manager2204: человек на слоте без ФИО, продаёт —
 * остаётся, а ФИО чинится в Битриксе). Итоги шапки — по видимым плиткам.
 */
export const RECENT_WORKING_DAYS = 5;

/** Активный менеджер дня: была заявка, бронь или продажа. */
export function isActiveToday(f: Record<FactId, number> | undefined): boolean {
  return !!f && (f.primary_deals_count + f.repeat_deals_count + f.primary_sales_count + f.repeat_sales_count + f.reservations_count > 0
    || f.primary_sales_amount + f.repeat_sales_amount + f.reservations_amount > 0);
}

export interface Totals { planDay: number; factDay: number; salesCount: number; bookSum: number; bookCount: number; activeManagers: number; pb: number }
export function totalsOf(managers: RosterManager[], facts: Map<string, Record<FactId, number>>, plans: Map<string, { planSales: number }>): Totals {
  const t: Totals = { planDay: 0, factDay: 0, salesCount: 0, bookSum: 0, bookCount: 0, activeManagers: 0, pb: 0 };
  for (const m of managers) {
    const f = facts.get(m.managerId);
    t.planDay += m.login ? plans.get(m.login)?.planSales ?? 0 : 0;
    if (!f) continue;
    const sc = f.primary_sales_count + f.repeat_sales_count;
    t.factDay += f.primary_sales_amount + f.repeat_sales_amount;
    t.salesCount += sc;
    t.bookSum += f.reservations_amount;
    t.bookCount += f.reservations_count;
    t.pb += sc + f.reservations_count;
    if (isActiveToday(f)) t.activeManagers++;
  }
  t.planDay = Math.round(t.planDay);
  return t;
}

/** Карточки подчинённых узлов (≥2 с людьми); узлы без плана и без движения за день
 *  (ЮЛ, стажировка — одни заглушки) карточкой не показываем. */
function cardsFor(node: TvNode, childManagers: Map<string, RosterManager[]>, facts: Map<string, Record<FactId, number>>,
  plans: Map<string, { planSales: number }>, dailyTarget: number): TvFeedCard[] {
  const cards: TvFeedCard[] = [];
  const kids = node.children.filter(c => (childManagers.get(c.id)?.length ?? 0) > 0);
  if (kids.length < 2) return cards;
  for (const c of kids) {
    const ct = totalsOf(childManagers.get(c.id) ?? [], facts, plans);
    if (ct.planDay <= 0 && ct.pb <= 0 && ct.factDay <= 0) continue;
    cards.push({ id: c.id, name: c.name, planDay: ct.planDay, factDay: ct.factDay, salesCount: ct.salesCount,
      bookSum: ct.bookSum, bookCount: ct.bookCount, activeManagers: ct.activeManagers, target: ct.activeManagers * dailyTarget, pb: ct.pb });
  }
  cards.sort((a, b) => b.factDay - a.factDay || b.bookSum - a.bookSum);
  return cards;
}

const ROOT_HOLD_SEC = 30;   // «Монолит»: филиалы карточками
const BRANCH_HOLD_SEC = 15; // затем отделы каждого филиала

/**
 * Слайд узла: итоги по ВСЕМ менеджерам узла; плитки — только с продажей/бронью за день
 * (правка владельца 08.09: «нули не показывать»); карточки подчинённых узлов — если
 * узел объединяет ≥2 узла с людьми («экран отделов» по аналогии с плитками менеджеров).
 * Цель бронепродаж = активные менеджеры × dailyTarget экрана («в отделе N / 95 при 19 активных»).
 */
function slideFor(node: TvNode, managers: RosterManager[], childManagers: Map<string, RosterManager[]>,
  facts: Map<string, Record<FactId, number>>, plans: Map<string, { planSales: number }>,
  avatars: Map<string, string | null>, recentActive: Set<string>, dailyTarget: number): TvFeedSlide {
  const shown = managers.filter(m => !isPlaceholderName(m.name) || recentActive.has(m.managerId));
  const rows: TvFeedManager[] = shown.map(m => {
    const f = facts.get(m.managerId);
    const plan = m.login ? plans.get(m.login)?.planSales ?? 0 : 0;
    return {
      id: m.managerId, name: m.name, avatar: avatars.get(m.managerId) ?? null,
      plan: Math.round(plan),
      salesCount: f ? f.primary_sales_count + f.repeat_sales_count : 0,
      salesSum: f ? f.primary_sales_amount + f.repeat_sales_amount : 0,
      bookCount: f ? f.reservations_count : 0,
      bookSum: f ? f.reservations_amount : 0,
    };
  });
  rows.sort((a, b) => b.salesSum - a.salesSum || b.bookSum - a.bookSum || a.name.localeCompare(b.name, 'ru'));
  const active = rows.filter(r => r.salesCount > 0 || r.bookCount > 0 || r.salesSum > 0 || r.bookSum > 0);
  const t = totalsOf(managers, facts, plans);

  const cards = cardsFor(node, childManagers, facts, plans, dailyTarget);
  return {
    key: node.id, dept: node.name,
    planDay: t.planDay, factDay: t.factDay, salesCount: t.salesCount, bookSum: t.bookSum, bookCount: t.bookCount,
    activeManagers: t.activeManagers, target: t.activeManagers * dailyTarget, pb: t.pb,
    cards, ticker: null, managers: active,
  };
}

/**
 * Собрать фид экрана. buildId — версия сервера для авто-перезагрузки телевизора.
 * deptNames — id→имя для заголовков слайдов.
 */
export async function buildScreenFeed(
  screen: TvScreen,
  deptNames: Map<string, string>,
  buildId: string,
  opts?: { bypassCache?: boolean; node?: string | null },
): Promise<TvFeedOk> {
  const today = mskTodayStr();
  // Проваливание с телевизора (правка владельца 08.09): node — под-узел одного из узлов
  // экрана; фид строится как для экрана из одного этого узла (проверка принадлежности —
  // в роуте через nodeWithin).
  if (opts?.node) screen = { ...screen, departmentIds: [opts.node], mode: 'carousel' };
  const key = `tv:feed:${screen.id}:${today}:${screen.updatedAt}:${opts?.node ?? ''}`;
  const build = async () => {
    const fromIso = mskMidnightIso(today);
    const toExclIso = mskMidnightIso(addDaysStr(today, 1));

    const [tree, orgRows, chains] = await Promise.all([buildTvTree(), loadActiveManagers(), deptChains()]);
    const dailyTarget = screen.settings.dailyTarget || 5;
    // Слайды: узел → слайд. «Монолит» (root) — один слайд: слева всегда общая агрегация,
    // справа филиалы карточками (30 с), затем отделы каждого филиала (по 15 с), без ротации
    // менеджеров (правка владельца 08.09).
    const slideNodes: TvNode[] = [];
    for (const id of screen.departmentIds) {
      const n = tree.byId.get(id);
      if (n) slideNodes.push(n);
    }
    const mgrCache = new Map<string, RosterManager[]>();
    const mgrs = (n: TvNode): RosterManager[] => {
      let v = mgrCache.get(n.id);
      if (!v) { v = managersOfNode(n, orgRows, chains); mgrCache.set(n.id, v); }
      return v;
    };
    // объединение без дублей — для фактов/планов/аватаров/событий
    const seen = new Set<string>();
    const managers: RosterManager[] = [];
    for (const n of slideNodes) for (const m of mgrs(n)) { if (!seen.has(m.managerId)) { seen.add(m.managerId); managers.push(m); } }
    const idsNum = [...new Set(managers.map(m => Number(m.managerId)).filter(n => Number.isInteger(n) && n > 0))];
    const names = new Map(managers.map(m => [m.managerId, m.name]));

    const placeholderIds = managers.filter(m => isPlaceholderName(m.name)).map(m => Number(m.managerId)).filter(n => Number.isInteger(n) && n > 0);
    const [facts, planRes, avatars, sales, recentActive] = await Promise.all([
      fetchFactsByManager(idsNum, fromIso, toExclIso),
      computePeriodPlanByLogin(today, today, today),
      fetchAvatars(managers.map(m => m.managerId)),
      fetchTodaySales(idsNum, fromIso, toExclIso, names),
      recentlyActiveIds(placeholderIds, workingDaysBackIso(today, RECENT_WORKING_DAYS), toExclIso),
    ]);
    const plans = planRes.byLogin;

    // Бегущая строка — своя у отдела (правка владельца 07.09: ЖБИ читает остаток
    // склада, ОС МСК — про скандик), иначе общая строка экрана. Мастер-выключатель —
    // ticker_enabled. Рассылки (tv_messages) добавляет клиент поверх.
    const general = screen.tickerEnabled && screen.tickerText?.trim() ? screen.tickerText.trim() : null;

    const slides: TvFeedSlide[] = [];
    const childMap = (n: TvNode) => new Map(n.children.map(c => [c.id, mgrs(c)] as const));
    if (screen.mode === 'merged') {
      // одна сетка: все выбранные узлы вместе; карточки — сами выбранные узлы
      const virtual: TvNode = {
        id: 'merged', kind: 'branch', children: slideNodes,
        name: slideNodes.map(n => n.name).join(' + ') || screen.name,
        deptUuids: new Set(), exactUuids: new Set(),
      };
      const slide = slideFor(virtual, managers, childMap(virtual), facts, plans, avatars, recentActive, dailyTarget);
      const own = screen.departmentIds.map(id => screen.settings.deptTickers[id]?.trim()).filter((t): t is string => !!t);
      slide.ticker = screen.tickerEnabled ? (own.length ? own.join('   \u2022   ') : general) : null;
      slides.push(slide);
    } else {
      for (const n of slideNodes) {
        const slide = slideFor(n, mgrs(n), childMap(n), facts, plans, avatars, recentActive, dailyTarget);
        if (n.kind === 'root') {
          // филиалы → топ-6 менеджеров компании (правка владельца: «наряду с филиалами топ-6
          // менеджеров в принципе») → отделы каждого филиала
          slide.pageSeq = [{ kind: 'cards', label: null, holdSec: ROOT_HOLD_SEC, cards: slide.cards }];
          if (slide.managers.length > 0) slide.pageSeq.push({ kind: 'managers', label: 'топ-6', holdSec: BRANCH_HOLD_SEC, managers: slide.managers.slice(0, 6) });
          for (const b of n.children) {
            const bc = cardsFor(b, childMap(b), facts, plans, dailyTarget);
            if (bc.length > 0) slide.pageSeq.push({ kind: 'cards', label: b.name, holdSec: BRANCH_HOLD_SEC, cards: bc });
          }
          slide.managers = [];
          slide.noManagers = true;
        }
        // строка: своя у узла; для филиала внутри «Монолита» — строка Монолита, потом общая
        const own = screen.settings.deptTickers[n.id]?.trim()
          || (screen.departmentIds.includes(tree.root.id) ? screen.settings.deptTickers[tree.root.id]?.trim() : undefined);
        slide.ticker = screen.tickerEnabled ? (own || general) : null;
        slides.push(slide);
      }
    }
    return { slides, sales, day: today };
  };
  // Событие sa_deals_changed (задача #5636, lib/tv/notifier.ts) означает «за 1-3 с
  // в базе появилась свежая продажа/бронь/переброска сделки» — Redis TTL=20с в
  // этот момент был бы гарантированной ложью, поэтому SSE-триггер идёт мимо кэша
  // прямым SQL «сегодня». Периодический fallback-опрос продолжает бить в кэш
  // (в этом и смысл: десять ТВ одного отдела = один запрос раз в 20 с).
  // fresh=1 — не полный обход кэша, а короткий кэш 3 с (правка 08.09): десять
  // телевизоров одного отдела, разбуженные одним NOTIFY, всё равно делают один SQL.
  const body = opts?.bypassCache ? await cached(`${key}:fresh`, 3, build) : await cached(key, FEED_TTL_SEC, build);

  const messages = await activeMessagesForScreen(screen.id).catch(() => []);
  return {
    state: 'ok',
    v: buildId,
    now: new Date().toISOString(),
    day: body.day,
    screen: {
      id: screen.id, name: screen.name, theme: screen.theme, mode: screen.mode, rotateSec: screen.rotateSec,
      ticker: screen.tickerEnabled && screen.tickerText?.trim() ? screen.tickerText.trim() : null,
      settings: screen.settings,
    },
    slides: body.slides,
    messages,
    sales: body.sales,
  };
}
