// «Дашборд тест» (задача владельца 08.10) — черновой дашборд директора по продажам:
// все филиалы → филиал → департаменты/отделы → команды отделов. По каждому узлу: план дня,
// факт продаж, брони (сумма), число продаж и число броней, % выполнения плана.
//
// Цифры считаются ТЕМИ ЖЕ движками, что у телевизоров и «РОП — сегодня»
// (features/tv/engine/feed.ts, orgTree.ts — здесь только импорт, без правок):
//   • факты — каталог метрик: продажи (перв. + повт.) по sold_at, брони по reserved_at;
//   • план дня — lib/plans/dailyPlan::computePeriodPlanByLogin;
//   • итог узла — по ВСЕМ его менеджерам (как на телевизоре).
// Отличие одно: день можно задать, а не только «сегодня».
//
// Для окна «Менеджеры» (нажатие на продажи/брони в карточке) ответ несёт ещё и строки
// менеджеров: по каждому — план дня, факт, брони, штуки. В узле лежат только id его
// менеджеров, сами строки — один раз в `managers`.

import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { computePeriodPlanByLogin } from '@/lib/plans/dailyPlan';
import { addDaysStr, fetchFactsByManager, mskMidnightIso, mskTodayStr, totalsOf } from '@/features/tv/engine/feed';
import { buildTvTree, deptChains, loadActiveManagers, managersOfNode, type TvNode } from '@/features/tv/engine/orgTree';
import type { RosterManager } from '@/lib/org/teamRoster';
import { scopeManagerIds, type SessionScope } from '@/lib/org/sessionScope';
import { scopeCacheKey } from './scope';

// ВРЕМЕННО, ПОКА РАЗДЕЛ В РАБОТЕ. В локальной копии базы «сегодня» может быть пустым,
// поэтому берём последний день, за который есть продажи. ПЕРЕД ВЫКЛАДКОЙ НА ПРОД
// поставить false — тогда дашборд всегда показывает сегодняшний день (решение владельца 08.10).
export const DASHBOARD_TEST_USE_LAST_DATA_DAY = false;

export interface DashTestNode {
  id: string;
  name: string;
  kind: 'root' | 'branch' | 'dept';
  plan: number;
  fact: number;
  /** % выполнения плана дня; null — плана на этот день нет. */
  pct: number | null;
  bookSum: number;
  salesCount: number;
  bookCount: number;
  /** Менеджеры узла, у которых за день есть план или движение (ключи DashTestResponse.managers). */
  managerIds: string[];
  children: DashTestNode[];
}

export interface DashTestManager {
  id: string;
  name: string;
  plan: number;
  fact: number;
  /** % выполнения плана дня; null — плана на этот день нет. */
  pct: number | null;
  bookSum: number;
  salesCount: number;
  bookCount: number;
}

export interface DashTestOrgCity { id: string; name: string; depts: { id: string; name: string }[] }

export interface DashTestResponse {
  /** День, за который посчитаны цифры (ГГГГ-ММ-ДД, Москва). */
  day: string;
  today: string;
  isToday: boolean;
  /** true — включён временный режим «последний день с данными». */
  lastDataDayMode: boolean;
  generatedAt: string;
  root: DashTestNode;
  /** Оргструктура для фильтров «Филиал» / «Департамент» — ВСЕ филиалы и департаменты, где есть
   *  менеджеры, независимо от плана и продаж за день. В root узлы без плана и движения за день
   *  отброшены, и в выходной (нет плана) фильтры пропадали целиком (найдено 10.10, суббота). */
  org: DashTestOrgCity[];
  /** Строки менеджеров по id — для окна «Менеджеры». */
  managers: Record<string, DashTestManager>;
}

const TTL_SEC = 30;

/** Последний день (по Москве), за который есть хотя бы одна продажа; не позже сегодня. */
async function lastDataDay(today: string): Promise<string> {
  const res = await analyticsDb().query<{ d: string | null }>(
    `SELECT to_char(max(sold_at) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS d
       FROM deals WHERE sold_at < $1`,
    [mskMidnightIso(addDaysStr(today, 1))],
  );
  return res.rows[0]?.d ?? today;
}

/**
 * scope — срез данных сессии (lib/org/sessionScope.ts, тот же механизм, что у «РОП — сегодня»
 * и отчётов): менеджеры вне среза выкидываются ДО расчёта, поэтому итоги узлов, список
 * менеджеров и оргструктура для фильтров (org) считаются только по ним. Без scope — вся компания.
 */
export async function buildDashboardTest(scope?: SessionScope): Promise<DashTestResponse> {
  const today = mskTodayStr();
  const day = DASHBOARD_TEST_USE_LAST_DATA_DAY ? await lastDataDay(today) : today;
  return cached(`dashtest:v4:${day}:${scopeCacheKey(scope)}`, TTL_SEC, async () => {
    const fromIso = mskMidnightIso(day);
    const toExclIso = mskMidnightIso(addDaysStr(day, 1));
    const [tree, orgRowsAll, chains] = await Promise.all([buildTvTree(), loadActiveManagers(), deptChains()]);
    const visible = scope ? scopeManagerIds(scope) : null; // null — без ограничения
    const visibleSet = visible ? new Set(visible) : null;
    const orgRows = visibleSet ? orgRowsAll.filter(r => visibleSet.has(r.manager_id)) : orgRowsAll;

    const all = managersOfNode(tree.root, orgRows, chains);
    const idsNum = [...new Set(all.map(m => Number(m.managerId)).filter(n => Number.isInteger(n) && n > 0))];
    const [facts, planRes] = await Promise.all([
      fetchFactsByManager(idsNum, fromIso, toExclIso),
      computePeriodPlanByLogin(day, day, day),
    ]);
    const plans = planRes.byLogin;

    // Глубина: 0 — все филиалы, 1 — филиал, 2 — департамент/отдел, 3 — команды внутри
    // департамента. Вкладка «Все» рисует уровни 0–2, «Подробно» и вкладки городов — ещё и 3.
    // Строка менеджера — те же поля и формулы, что в totalsOf(). Менеджеров без плана и
    // без движения за день в окне не показываем (на итог узла они не влияют — у них нули).
    const managers: Record<string, DashTestManager> = {};
    const hidden = new Set<string>();
    const managerRow = (m: RosterManager): DashTestManager | null => {
      const f = facts.get(m.managerId);
      const plan = Math.round(m.login ? plans.get(m.login)?.planSales ?? 0 : 0);
      const factRaw = f ? f.primary_sales_amount + f.repeat_sales_amount : 0;
      const salesCount = f ? f.primary_sales_count + f.repeat_sales_count : 0;
      const bookSum = f ? Math.round(f.reservations_amount) : 0;
      const bookCount = f ? f.reservations_count : 0;
      if (plan <= 0 && factRaw <= 0 && bookSum <= 0 && salesCount + bookCount <= 0) return null;
      return {
        id: m.managerId, name: m.name, plan, fact: Math.round(factRaw),
        pct: plan > 0 ? Math.round((factRaw / plan) * 100) : null,
        bookSum, salesCount, bookCount,
      };
    };

    const build = (n: TvNode, depth: number): DashTestNode => {
      const nodeManagers = managersOfNode(n, orgRows, chains);
      const t = totalsOf(nodeManagers, facts, plans);
      const managerIds: string[] = [];
      for (const m of nodeManagers) {
        if (!managers[m.managerId] && !hidden.has(m.managerId)) {
          const row = managerRow(m);
          if (row) managers[m.managerId] = row; else hidden.add(m.managerId);
        }
        if (managers[m.managerId] && !managerIds.includes(m.managerId)) managerIds.push(m.managerId);
      }
      const children = depth < 3
        ? n.children.map(c => build(c, depth + 1))
            // узлы без плана и без движения за день (стажировка, пустые отделы) не рисуем
            .filter(c => c.plan > 0 || c.fact > 0 || c.bookSum > 0 || c.salesCount + c.bookCount > 0)
        : [];
      // Порядок постоянный, чтобы карточки не прыгали в течение дня:
      // филиалы — по убыванию плана, отделы внутри филиала — по алфавиту.
      if (depth === 0) children.sort((a, b) => b.plan - a.plan || a.name.localeCompare(b.name, 'ru'));
      else children.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      return {
        id: n.id, name: n.name, kind: n.kind,
        plan: t.planDay, fact: Math.round(t.factDay),
        pct: t.planDay > 0 ? Math.round((t.factDay / t.planDay) * 100) : null,
        bookSum: Math.round(t.bookSum), salesCount: t.salesCount, bookCount: t.bookCount,
        managerIds, children,
      };
    };

    const root = build(tree.root, 0);
    // В фильтрах — подразделения с планом продаж на месяц (как в карточках «Сегодня» в будни:
    // без стажировки и отделов без плана). Если планов на месяц в базе нет — все, где есть менеджеры.
    // Филиалы — по плану месяца (крупные первыми), департаменты — по алфавиту.
    const monthFrom = `${day.slice(0, 8)}01`;
    const monthTo = addDaysStr(`${addDaysStr(monthFrom, 32).slice(0, 8)}01`, -1);
    const monthPlans = (await computePeriodPlanByLogin(monthFrom, monthTo, monthTo)).byLogin;
    const weight = (n: TvNode) => {
      const ms = managersOfNode(n, orgRows, chains);
      return { staff: ms.length, plan: ms.reduce((sum, m) => sum + (m.login ? monthPlans.get(m.login)?.planSales ?? 0 : 0), 0) };
    };
    const byPlan = monthPlans.size > 0;
    const keep = (w: { staff: number; plan: number }) => (byPlan ? w.plan > 0 : w.staff > 0);
    const org: DashTestOrgCity[] = tree.root.children
      .map(c => ({ c, w: weight(c) }))
      .filter(x => keep(x.w))
      .sort((a, b) => (b.w.plan - a.w.plan) || (b.w.staff - a.w.staff) || a.c.name.localeCompare(b.c.name, 'ru'))
      .map(({ c }) => ({
        id: c.id, name: c.name,
        depts: c.children.filter(d => keep(weight(d))).map(d => ({ id: d.id, name: d.name })).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      }));
    return {
      day, today, isToday: day === today, lastDataDayMode: DASHBOARD_TEST_USE_LAST_DATA_DAY,
      generatedAt: new Date().toISOString(), root, org, managers,
    };
  });
}
