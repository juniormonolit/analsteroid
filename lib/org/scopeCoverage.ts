import type { SessionScope } from './sessionScope';
import { BRANCH_LABELS, getManagerDeptIds, loadDepartments, resolveDeptCategory } from './deptCategories';
import { loadManagerBranchMap } from '@/lib/marketing/sources';

// ── Дополнения к срезу сессии (lib/org/sessionScope.ts) — аудит 09.09 ────────────
//
// 1. Движки с ТОЧНЫМ фильтром отдела. scopeDeptIdsBitrix отдаёт корни среза в
//    расчёте на движок, который сам раскрывает поддерево по цепочке предков. Но
//    графики (features/charts/engine/stageSurvival.ts::departmentsWhere) и
//    «Разгрузка» (features/offload/engine/offload.ts::fetchOpenDeals) матчат
//    orh.department_id ТОЧНО по списку — корень без потомков дал бы РОПу только
//    людей, приписанных к самому корню. Поэтому здесь — ВСЕ отделы среза
//    (поддерево уже раскрыто в scope.deptIds) в bitrix-формате.
//
// 2. Кэши «план/факт по филиалам и категориям» (lib/jobs/planSummary.ts,
//    lib/jobs/widgetMetrics.ts) считаются один раз на всю компанию и агрегированы
//    до филиала / категории («ОС», «НЦ», …) — уровня, которого в срезе сессии нет.
//    Правило выдачи: агрегат виден, только если КАЖДЫЙ отдел, попадающий в него,
//    входит в срез (иначе РОП одной команды увидел бы цифры всего департамента).
//    Директор («свой филиал и ниже», managerAccess.branchDepartmentIds) покрывает
//    филиал целиком — ему видны и филиал, и все его категории.

/** Все отделы среза в bitrix_department_id (для движков с точным матчем отдела).
 *  null — без ограничения; [] — смотреть нечего; при непустом requested — пересечение. */
export async function scopeDeptIdsBitrixExact(scope: SessionScope, requestedBitrix: string[] | undefined): Promise<string[] | null> {
  if (scope.kind === 'all') return requestedBitrix?.length ? requestedBitrix : null;
  if (scope.kind === 'self') return [];
  const { byId } = await loadDepartments();
  const allowed: string[] = [];
  for (const uuid of scope.deptIds) {
    const b = byId.get(uuid)?.bitrixId;
    if (b) allowed.push(String(b));
  }
  if (!requestedBitrix?.length) return allowed;
  const set = new Set(allowed);
  return requestedBitrix.filter(id => set.has(String(id)));
}

export interface ScopeCoverage {
  /** Метки филиалов (СПБ/МСК/КРД/…), покрытых срезом целиком. */
  branches: Set<string>;
  /** `${филиал}:${категория}` — категории филиала, покрытые целиком. */
  categories: Set<string>;
}

/** Филиал → метка как в plan_targets_year / кэшах (тот же маппинг, что planSummary/widgetMetrics). */
export function normalizeBranchLabel(raw: string | null | undefined): string {
  return raw ? (BRANCH_LABELS[raw] ?? raw) : 'СПБ';
}

/** Покрытие филиалов/категорий срезом. null — админ, ограничения нет. */
export async function loadScopeCoverage(scope: SessionScope): Promise<ScopeCoverage | null> {
  if (scope.kind === 'all') return null;
  const empty: ScopeCoverage = { branches: new Set(), categories: new Set() };
  if (scope.kind === 'self') return empty;

  const [branchByManager, managerDeptIds, { byId, byBitrixId }] = await Promise.all([
    loadManagerBranchMap(),
    getManagerDeptIds(),
    loadDepartments(),
  ]);

  // Какие отделы образуют каждый филиал и каждую категорию филиала.
  const branchDepts = new Map<string, Set<string>>();
  const categoryDepts = new Map<string, Set<string>>();
  for (const [managerId, deptId] of managerDeptIds) {
    if (!deptId) continue;
    const label = normalizeBranchLabel(branchByManager.get(managerId));
    (branchDepts.get(label) ?? branchDepts.set(label, new Set()).get(label)!).add(deptId);
    const category = resolveDeptCategory(label, deptId, byId, byBitrixId);
    if (category) {
      const key = `${label}:${category}`;
      (categoryDepts.get(key) ?? categoryDepts.set(key, new Set()).get(key)!).add(deptId);
    }
  }

  const covered = (depts: Set<string>) => [...depts].every(d => scope.deptIds.has(d));
  for (const [label, depts] of branchDepts) if (covered(depts)) empty.branches.add(label);
  for (const [key, depts] of categoryDepts) if (covered(depts)) empty.categories.add(key);
  return empty;
}
