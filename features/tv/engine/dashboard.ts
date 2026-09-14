// «Телевизоры» — интерактивный дашборд «Сегодня по компании» (правка владельца 08.09):
// вкладки Итого / филиалы, раскрытие департаментов в отделы и отделов в менеджеров.
// Те же данные и правила, что у фида телевизора (feed.ts): факты каталога за день по
// менеджерам, план дня, «активный» = заявка/бронь/продажа, цель бронепродаж =
// активные × dailyTarget, имена-заглушки — только при движении за 5 рабочих дней.
// Считается один раз для всей компании и кэшируется в Redis 20 с.

import { cached } from '@/lib/cache/redis';
import { computePeriodPlanByLogin } from '@/lib/plans/dailyPlan';
import type { RosterManager } from '@/lib/org/teamRoster';
import { isPlaceholderName, type TvFeedManager } from '../shared';
import {
  addDaysStr, fetchAvatars, fetchFactsByManager, isActiveToday, mskMidnightIso, mskTodayStr,
  recentlyActiveIds, RECENT_WORKING_DAYS, totalsOf, workingDaysBackIso, type FactId, type Totals,
} from './feed';
import { buildTvTree, deptChains, loadActiveManagers, managersOfNode, type OrgRow, type TvNode } from './orgTree';
import type { RopScope } from './access';

export interface TvDashManager extends TvFeedManager {
  dealsCount: number;   // заявки за день (created_at)
  active: boolean;      // заявка / бронь / продажа сегодня
  pb: number;
}

export interface TvDashNode extends Totals {
  id: string;
  name: string;
  kind: 'root' | 'branch' | 'dept';
  target: number;
  managerCount: number;          // всего людей в узле (после правила заглушек)
  children: TvDashNode[];        // подузлы с людьми
  directManagerIds: string[];    // приписаны к самому узлу, не к подузлам
  allManagerIds: string[];       // все менеджеры узла (для «показать людей» на любом уровне)
}

export interface TvDashboard {
  day: string;
  generatedAt: string;
  dailyTarget: number;
  root: TvDashNode;
  managers: Record<string, TvDashManager>;
}

const DASH_TTL_SEC = 20;
const DEFAULT_TARGET = 5;

// Срезает состав по зоне ответственности (/rop, задача #6446). Без scope (или
// scope.full) — полный состав, как у публичного /today. Дальше по коду везде
// подставляются УЖЕ обрезанные orgRows — дерево и КПИ каждого узла строятся
// рекурсией managersOfNode() из dashboard-движка без изменений: пустые ветки
// сами отваливаются в build() (children.filter(c => c.managerCount > 0)).
export function scopeRows(rows: OrgRow[], scope?: RopScope): OrgRow[] {
  if (!scope || scope.full) return rows;
  if (scope.selfOnly) return rows.filter(r => r.manager_id === scope.selfOnly);
  const allowed = scope.allowedDeptIds;
  if (!allowed || allowed.size === 0) return []; // нет ни отделов, ни себя — пустой дашборд, не чужие данные
  return rows.filter(r => r.department_id != null && allowed.has(r.department_id));
}

export async function buildDashboard(dailyTarget = DEFAULT_TARGET, scope?: RopScope): Promise<TvDashboard> {
  const today = mskTodayStr();
  // Кэш-ключ обязан учитывать скоуп: иначе полный /today-расчёт и урезанный
  // /rop-расчёт за тот же день перезаписывали бы друг друга в Redis.
  const scopeKey = !scope || scope.full ? 'full'
    : scope.selfOnly ? `self:${scope.selfOnly}`
    : `depts:${[...(scope.allowedDeptIds ?? [])].sort().join(',') || 'none'}`;
  return cached(`tv:dash:${today}:${dailyTarget}:${scopeKey}`, DASH_TTL_SEC, async () => {
    const fromIso = mskMidnightIso(today);
    const toExclIso = mskMidnightIso(addDaysStr(today, 1));
    const [tree, orgRowsAll, chains] = await Promise.all([buildTvTree(), loadActiveManagers(), deptChains()]);
    const orgRows = scopeRows(orgRowsAll, scope);

    const all = managersOfNode(tree.root, orgRows, chains);
    const idsNum = [...new Set(all.map(m => Number(m.managerId)).filter(n => Number.isInteger(n) && n > 0))];
    const placeholderIds = all.filter(m => isPlaceholderName(m.name)).map(m => Number(m.managerId)).filter(n => Number.isInteger(n) && n > 0);
    const [facts, planRes, avatars, recentActive] = await Promise.all([
      fetchFactsByManager(idsNum, fromIso, toExclIso),
      computePeriodPlanByLogin(today, today, today),
      fetchAvatars(all.map(m => m.managerId)),
      recentlyActiveIds(placeholderIds, workingDaysBackIso(today, RECENT_WORKING_DAYS), toExclIso),
    ]);
    const plans = planRes.byLogin;

    // видимые люди: нормальное ФИО или движение за 5 рабочих дней (то же правило, что на ТВ)
    const visibleRows: OrgRow[] = orgRows.filter(r => !isPlaceholderName(r.manager_name) || recentActive.has(r.manager_id));
    const managers: Record<string, TvDashManager> = {};
    for (const m of all) {
      if (isPlaceholderName(m.name) && !recentActive.has(m.managerId)) continue;
      const f = facts.get(m.managerId);
      const sc = f ? f.primary_sales_count + f.repeat_sales_count : 0;
      const bc = f ? f.reservations_count : 0;
      managers[m.managerId] = {
        id: m.managerId, name: m.name, avatar: avatars.get(m.managerId) ?? null,
        plan: Math.round(m.login ? plans.get(m.login)?.planSales ?? 0 : 0),
        salesCount: sc, salesSum: f ? f.primary_sales_amount + f.repeat_sales_amount : 0,
        bookCount: bc, bookSum: f ? f.reservations_amount : 0,
        dealsCount: f ? f.primary_deals_count + f.repeat_deals_count : 0,
        active: isActiveToday(f), pb: sc + bc,
      };
    }

    const cache = new Map<string, RosterManager[]>();
    const mgrs = (n: TvNode): RosterManager[] => {
      let v = cache.get(n.id);
      if (!v) { v = managersOfNode(n, visibleRows, chains); cache.set(n.id, v); }
      return v;
    };
    const build = (n: TvNode): TvDashNode => {
      const ms = mgrs(n);
      const t = totalsOf(ms, facts as Map<string, Record<FactId, number>>, plans);
      const children = n.children.map(build).filter(c => c.managerCount > 0);
      const childIds = new Set<string>();
      for (const c of children) for (const id of c.allManagerIds) childIds.add(id);
      const sortKey = (a: TvDashNode, b: TvDashNode) => b.factDay - a.factDay || b.bookSum - a.bookSum || a.name.localeCompare(b.name, 'ru');
      children.sort(sortKey);
      const allIds = ms.map(m => m.managerId);
      return {
        id: n.id, name: n.name, kind: n.kind, ...t, target: t.activeManagers * dailyTarget,
        managerCount: ms.length, children,
        directManagerIds: allIds.filter(id => !childIds.has(id)),
        allManagerIds: allIds,
      };
    };
    return { day: today, generatedAt: new Date().toISOString(), dailyTarget, root: build(tree.root), managers };
  });
}
