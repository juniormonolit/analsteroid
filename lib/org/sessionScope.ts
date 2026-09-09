import type { SessionUser } from '@/lib/auth/session';
import { loadDepartments } from './deptCategories';
import { hasFullManagerAccess, managedDepartmentIds } from './managerAccess';
import { resolveManagersForDepartments } from './teamRoster';

// ── Срез данных сессии — ОДИН механизм для всех роутов данных и справочников ─────
//
// Аудит 09.09 (ai_docs/fresh_docs/ACCESS_AUDIT_2026-09-09.md): модель доступа
// (lib/org/managerAccess.ts) применялась только «отделочными» роутами — карточки,
// сводная, ТВ; ядро отчётов (/api/reports/*, charts/*, plans/*) проверяло лишь
// наличие сессии и верило departmentIds/managerId/all=1 из запроса. Требование
// владельца: только Администратор/супер-админ видит всё; Директор — свой филиал и
// ниже; РОП — себя и подконтрольные отделы с поддеревом; МОП/«Пользователь» —
// только себя; справочники-пикеры режутся тем же срезом.
//
// Использование в роуте: scope = await getSessionScope(session), затем либо
// scopeDeptIds(scope, requested) → эффективные отделы для движка (null = без
// ограничения, [] = смотреть нечего), либо scopeManagerIds / canSeeManager для
// менеджерских разрезов и проверок владельца сущности (сделка, клиент, план).
// Пустой запрос клиента («все отделы») означает ВЕСЬ СРЕЗ сессии, а не всю компанию.

export type SessionScope =
  | { kind: 'all' }
  /** РОП / Директор: корни подконтрольных отделов + все потомки (uuid) и их менеджеры. */
  | { kind: 'depts'; rootDeptIds: Set<string>; deptIds: Set<string>; managerIds: Set<string> }
  /** МОП, «Пользователь», логист без отделов: только свой bitrix id (может быть пусто). */
  | { kind: 'self'; managerIds: Set<string> };

/** Все потомки корней по дереву sa.departments (включая сами корни), uuid. */
export async function expandDepartmentSubtree(rootUuids: string[]): Promise<Set<string>> {
  const { byId, byBitrixId } = await loadDepartments();
  const out = new Set<string>(rootUuids);
  const rootBitrix = new Set(rootUuids.map(u => byId.get(u)?.bitrixId).filter((v): v is string => !!v));
  if (rootBitrix.size === 0) return out;
  // Отдел — потомок корня, если по цепочке parentBitrixId доходит до одного из корней.
  for (const [uuid, row] of byId) {
    let cur = row.parentBitrixId;
    for (let guard = 0; cur && guard < 15; guard++) {
      if (rootBitrix.has(cur)) { out.add(uuid); break; }
      cur = byBitrixId.get(cur)?.parentBitrixId ?? null;
    }
  }
  return out;
}

export async function getSessionScope(session: SessionUser): Promise<SessionScope> {
  if (hasFullManagerAccess(session)) return { kind: 'all' };
  const roots = await managedDepartmentIds(session);
  const self = session.bitrixUserId ? [session.bitrixUserId] : [];
  if (roots.length === 0) return { kind: 'self', managerIds: new Set(self) };
  const [deptIds, roster] = await Promise.all([
    expandDepartmentSubtree(roots),
    resolveManagersForDepartments(roots),
  ]);
  return {
    kind: 'depts',
    rootDeptIds: new Set(roots),
    deptIds,
    managerIds: new Set([...self, ...roster.map(m => m.managerId)]),
  };
}

/**
 * Эффективные отделы для движка. null — ограничения нет (админ); [] — человеку
 * смотреть нечего (не-админ без отделов, или запрошены только чужие).
 * requested — то, что прислал клиент (bitrix_department_id или uuid — как принимает
 * вызывающий движок; сравнение по строкам, поэтому передавайте тот же формат, что в
 * deptIds — см. scopeDeptIdsBitrix для bitrix-формата фильтра отчётов).
 */
export function scopeDeptIds(scope: SessionScope, requested: string[] | undefined): string[] | null {
  if (scope.kind === 'all') return requested?.length ? requested : null;
  if (scope.kind === 'self') return [];
  const allowed = scope.deptIds;
  if (!requested?.length) return [...scope.rootDeptIds];
  return requested.filter(id => allowed.has(id));
}

/** Эффективные менеджеры: null — без ограничения; [] — никого. */
export function scopeManagerIds(scope: SessionScope, requested?: string[]): string[] | null {
  if (scope.kind === 'all') return requested?.length ? requested : null;
  const allowed = scope.managerIds;
  if (!requested?.length) return [...allowed];
  return requested.filter(id => allowed.has(id));
}

export function canSeeManager(scope: SessionScope, managerBitrixId: string | null | undefined): boolean {
  if (scope.kind === 'all') return true;
  return !!managerBitrixId && scope.managerIds.has(String(managerBitrixId));
}

export function canSeeDept(scope: SessionScope, deptUuid: string): boolean {
  if (scope.kind === 'all') return true;
  return scope.kind === 'depts' && scope.deptIds.has(deptUuid);
}

/** Стандартный отказ роутов данных. */
export function scopeForbidden(what = 'Эти данные вам недоступны'): Response {
  return Response.json({ error: what }, { status: 403 });
}

// ── Формат bitrix_department_id (фильтр «отделы» в отчётах) ─────────────────────
//
// Движки отчётов принимают departmentIds как bitrix_department_id (строки), а срез
// сессии хранит uuid sa.departments. Возвращает эффективный список в bitrix-формате:
// null — без ограничения; [] — смотреть нечего; иначе пересечение запрошенного со
// срезом (или весь срез, если клиент ничего не прислал).
export async function scopeDeptIdsBitrix(scope: SessionScope, requestedBitrix: string[] | undefined): Promise<string[] | null> {
  if (scope.kind === 'all') return requestedBitrix?.length ? requestedBitrix : null;
  if (scope.kind === 'self') return [];
  const { byId } = await loadDepartments();
  const allowedBitrix = new Set<string>();
  for (const uuid of scope.deptIds) {
    const b = byId.get(uuid)?.bitrixId;
    if (b) allowedBitrix.add(String(b));
  }
  if (!requestedBitrix?.length) {
    // ВСЕ отделы среза (корни + потомки), не только корни: движки отчётов
    // (byManagers/byProductGroups/byPeriods/byClients/clientMetrics) матчат
    // orh.department_id ТОЧНО, по дереву не спускаются — с одними корнями
    // менеджеры дочерних отделов выпали бы (замечание ревью 09.09).
    return [...allowedBitrix];
  }
  return requestedBitrix.filter(id => allowedBitrix.has(String(id)));
}
