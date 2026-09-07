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
import { resolveManagersForDepartments, type RosterManager } from '@/lib/org/teamRoster';
import { getManagerAvatarUrl } from '@/lib/bitrix/managerAvatar';
import { cached } from '@/lib/cache/redis';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { isPlaceholderName, type TvFeedManager, type TvFeedOk, type TvFeedSale, type TvFeedSlide, type TvScreen } from '../shared';
import { activeMessagesForScreen } from './store';

const TZ = 'Europe/Moscow';
const FEED_TTL_SEC = 20;

const FACT_IDS = [
  'primary_sales_count', 'repeat_sales_count', 'primary_sales_amount', 'repeat_sales_amount',
  'reservations_count', 'reservations_amount',
] as const;
type FactId = (typeof FACT_IDS)[number];

export function mskTodayStr(): string {
  const now = toZonedTime(new Date(), TZ);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function mskMidnightIso(dateStr: string): string {
  return fromZonedTime(`${dateStr} 00:00:00`, TZ).toISOString();
}
function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fetchFactsByManager(idsNum: number[], fromIso: string, toExclIso: string): Promise<Map<string, Record<FactId, number>>> {
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
async function fetchAvatars(ids: string[]): Promise<Map<string, string | null>> {
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

/**
 * Кого показывать на плитках (замечание владельца 07.09 про manager2014):
 *  • пустой слот Битрикса — имя-заглушка И нет плана на месяц И нет продаж/броней
 *    за день — скрыт всегда (org_resolved_hierarchy держит его is_active=true,
 *    других признаков «нет человека» у нас нет; у manager2204 план есть — значит
 *    человек есть, показываем как есть, пока в Битриксе не заполнят ФИО);
 *  • hideIdle (настройка экрана) — скрыть любого без плана и без движения за день.
 * Итоги шапки считаются по ВИДИМЫМ плиткам — у скрытых они по построению нули.
 */
function visibleManager(m: RosterManager, hasPlan: boolean, f: Record<FactId, number> | undefined, hideIdle: boolean): boolean {
  const moved = !!f && (f.primary_sales_count + f.repeat_sales_count + f.reservations_count > 0
    || f.primary_sales_amount + f.repeat_sales_amount + f.reservations_amount > 0);
  if (hasPlan || moved) return true;
  if (isPlaceholderName(m.name)) return false;
  return !hideIdle;
}

function slideFor(key: string, title: string, managers: RosterManager[], facts: Map<string, Record<FactId, number>>,
  plans: Map<string, { planSales: number }>, avatars: Map<string, string | null>, hideIdle: boolean): TvFeedSlide {
  const shown = managers.filter(m => visibleManager(m, !!(m.login && plans.has(m.login)), facts.get(m.managerId), hideIdle));
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
  const sum = (fn: (r: TvFeedManager) => number) => rows.reduce((a, r) => a + fn(r), 0);
  return {
    key, dept: title,
    planDay: sum(r => r.plan), factDay: sum(r => r.salesSum), salesCount: sum(r => r.salesCount),
    bookSum: sum(r => r.bookSum), bookCount: sum(r => r.bookCount),
    managers: rows,
  };
}

/**
 * Собрать фид экрана. buildId — версия сервера для авто-перезагрузки телевизора.
 * deptNames — id→имя для заголовков слайдов.
 */
export async function buildScreenFeed(screen: TvScreen, deptNames: Map<string, string>, buildId: string): Promise<TvFeedOk> {
  const today = mskTodayStr();
  const key = `tv:feed:${screen.id}:${today}:${screen.updatedAt}`;
  const body = await cached(key, FEED_TTL_SEC, async () => {
    const fromIso = mskMidnightIso(today);
    const toExclIso = mskMidnightIso(addDaysStr(today, 1));

    const managers = await resolveManagersForDepartments(screen.departmentIds);
    const idsNum = [...new Set(managers.map(m => Number(m.managerId)).filter(n => Number.isInteger(n) && n > 0))];
    const names = new Map(managers.map(m => [m.managerId, m.name]));

    const [facts, planRes, avatars, sales] = await Promise.all([
      fetchFactsByManager(idsNum, fromIso, toExclIso),
      computePeriodPlanByLogin(today, today, today),
      fetchAvatars(managers.map(m => m.managerId)),
      fetchTodaySales(idsNum, fromIso, toExclIso, names),
    ]);
    const plans = planRes.byLogin;

    const slides: TvFeedSlide[] = [];
    if (screen.mode === 'merged') {
      const title = screen.departmentIds.map(id => deptNames.get(id) ?? 'Отдел').join(' + ');
      slides.push(slideFor('merged', title || screen.name, managers, facts, plans, avatars, screen.settings.hideIdle));
    } else {
      for (const deptId of screen.departmentIds) {
        const own = managers.filter(m => m.deptUuid === deptId);
        slides.push(slideFor(deptId, deptNames.get(deptId) ?? 'Отдел', own, facts, plans, avatars, screen.settings.hideIdle));
      }
    }
    return { slides, sales, day: today };
  });

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
