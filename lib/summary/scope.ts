// Права доступа + фильтр филиала для дашборда «Сводная» (задача 1704).
//
// Модель прав — ТА ЖЕ «Руководит» (user_departments), что уже используют
// app/api/manager-card/team/route.ts и app/api/manager-card/department-card/route.ts:
// смотрящему назначены отделы (user_departments), видимость = сам отдел + ВСЕ его
// потомки по дереву departments (resolveManagersForDepartments — subtree, не точное
// совпадение). Если назначений нет, а роль элевейтед (супер-админ/Директор/
// Администратор — тот же список ролей, что в manager-card/team) — фолбэк на корневые
// узлы дерева (видит всё). Если назначений нет и роль обычная — пустой скоуп
// (hasAccess=false), UI показывает «Отделы не назначены» (та же фраза, что и
// features/profile/ui/DeptRosterGrid.tsx для аналогичного случая).
//
// Это НАМЕРЕННО НЕ используется для блока «План/факт по филиалам»
// (getCachedPlanSummary) — тот эндпоинт считает ОДИН глобальный кэш на всю компанию
// (джоба раз в 10 мин, использует ещё и /api/widget-metrics/plan), пересчитывать его
// per-viewer — отдельная задача большего масштаба, чем редизайн сетки (бриф 1704,
// п.2 «редизайн — без нового API»). Блок 2/3 (план+проблемная зона) остаются
// компанейски-глобальными, как и раньше; фильтр ФИЛИАЛА (см. ниже) на них всё же
// действует — они и так уже разложены по филиалам.

import type { SessionUser } from '@/lib/auth/session';
import {
  getUserDepartmentOptions, getRootDepartmentOptions, resolveManagersForDepartments,
  type DeptOption,
} from '@/lib/org/teamRoster';
import { getManagerOrgMap } from '@/lib/org/deptCategories';

export const BRANCH_VALUES = ['all', 'КРД', 'МСК', 'СПБ'] as const;
export type BranchFilter = (typeof BRANCH_VALUES)[number];

export function parseBranchParam(v: string | null): BranchFilter {
  return v && (BRANCH_VALUES as readonly string[]).includes(v) ? (v as BranchFilter) : 'all';
}

export interface SummaryScope {
  /** bitrix_user_id менеджеров, видимых смотрящему (уже пересечён с фильтром филиала). */
  managerIds: Set<string>;
  /** false = у пользователя вообще нет назначенных отделов (и он не элевейтед) — не «пусто после фильтра». */
  hasAccess: boolean;
  departmentOptions: DeptOption[];
}

const ELEVATED_ROLES = new Set(['Директор', 'Администратор']);

export async function resolveSummaryScope(session: SessionUser, branch: BranchFilter): Promise<SummaryScope> {
  const isElevated = session.isSuperadmin || (session.roleName !== null && ELEVATED_ROLES.has(session.roleName));

  let options = await getUserDepartmentOptions(session.id);
  if (options.length === 0 && isElevated) {
    options = await getRootDepartmentOptions();
  }
  if (options.length === 0) {
    return { managerIds: new Set(), hasAccess: false, departmentOptions: [] };
  }

  const roster = await resolveManagersForDepartments(options.map(o => o.id));
  let managerIds = new Set(roster.map(r => r.managerId));

  if (branch !== 'all') {
    const orgMap = await getManagerOrgMap();
    managerIds = new Set([...managerIds].filter(id => orgMap.get(id)?.branch === branch));
  }

  return { managerIds, hasAccess: true, departmentOptions: options };
}
