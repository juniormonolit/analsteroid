import type { SessionUser } from '@/lib/auth/session';
import { getCallControlManagedDepts } from './callControlScope';
import { getUserDepartmentOptions, resolveManagersForDepartments } from './teamRoster';
import { analyticsDb } from '@/lib/db/clients';
import { loadDepartments } from './deptCategories';

// Кто вправе смотреть карточку КОНКРЕТНОГО менеджера (задача владельца 30.07,
// «Вариант Б»: ЛК открывается всем менеджерам из Битрикса, пользователи создаются
// автоматически при первом входе). До этого роуты /api/manager-card/* и страница
// /manager/[id] проверяли ТОЛЬКО наличие сессии — при 20 доверенных аккаунтах это
// было терпимо, но с автосозданием ~170 менеджеров любой смог бы читать рейтинг,
// план/факт и суммы продаж коллеги, подставив его bitrix id в URL.
//
// Модель доступа (сознательно совпадает с той, что уже была на «отделочных»
// роутах department-card/team, чтобы не вводить вторую систему понятий):
//   * свою карточку — всегда;
//   * супер-админ, «Администратор», «Директор» — любую (руководство компании,
//     сегодня у них и так полный доступ; не отнимаем);
//   * РОП и любой, у кого есть подконтрольные отделы — карточки менеджеров этих
//     отделов (КЗ-структура + назначения админом в user_departments);
//   * остальные («МОП», «Пользователь», автосозданные из Битрикса) — только себя.
// Директор ИСКЛЮЧЁН из полного доступа (аудит 09.09, требование владельца): он
// видит свой филиал и ниже — филиал добавляется в managedDepartmentIds ниже.
const FULL_ACCESS_ROLES = new Set(['Администратор']);

export function hasFullManagerAccess(session: SessionUser): boolean {
  return session.isSuperadmin || (!!session.roleName && FULL_ACCESS_ROLES.has(session.roleName));
}

/** Отделы, чьи данные пользователь вправе смотреть: КЗ-структура ∪ назначенные админом. */
export async function managedDepartmentIds(session: SessionUser): Promise<string[]> {
  const [cc, assigned, branch] = await Promise.all([
    session.bitrixUserId ? getCallControlManagedDepts(session.bitrixUserId) : Promise.resolve([]),
    getUserDepartmentOptions(session.id),
    session.roleName === 'Директор' && session.bitrixUserId ? branchDepartmentIds(session.bitrixUserId) : Promise.resolve([]),
  ]);
  return [...new Set([...cc.map(d => d.deptId), ...assigned.map(d => d.id), ...branch])];
}

/**
 * Директор — «свой филиал и ниже» (правило владельца 09.09): все активные отделы
 * филиала, в котором директор сам числится в оргструктуре. Если его нет в
 * org_resolved_hierarchy (не менеджер) — филиал не определить, остаются КЗ-отделы
 * и назначения админа.
 *
 * Правка 11.10 (#9395, вариант A Сергея): отдел, в поддереве которого есть менеджеры ДРУГИХ
 * филиалов («Отдел продаж», «Дирекция» — над всеми филиалами), корнем филиала не берётся:
 * expandDepartmentSubtree развернул бы его до всей компании, и Директор СПб видел бы всех.
 * Сотрудники, привязанные к такому отделу напрямую, остаются видимыми директору своего
 * филиала — отдельным списком (branchDirectManagerIds), а не через отделы.
 */
async function branchScopeFor(bitrixUserId: string): Promise<{ deptIds: string[]; directManagerIds: string[] }> {
  const rows = (await analyticsDb().query<{ department_id: string | null; manager_id: string; branch: string | null }>(
    `SELECT department_id::text AS department_id, manager_bitrix_user_id::text AS manager_id, branch
       FROM sa.org_resolved_hierarchy WHERE is_active`,
  )).rows;
  const me = rows.find(r => r.manager_id === bitrixUserId);
  if (!me) return { deptIds: [], directManagerIds: [] };
  const { byId, byBitrixId } = await loadDepartments();
  const uuidByBitrix = new Map<string, string>();
  for (const [uuid, v] of byId) uuidByBitrix.set(v.bitrixId, uuid);
  // какие филиалы (непустые) есть в поддереве каждого отдела: идём от отдела менеджера вверх
  const branchesIn = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.branch || !r.department_id) continue;
    let cur = byId.get(r.department_id);
    const seen = new Set<string>([r.department_id]);
    if (!branchesIn.has(r.department_id)) branchesIn.set(r.department_id, new Set());
    branchesIn.get(r.department_id)!.add(r.branch);
    for (let guard = 0; cur?.parentBitrixId && guard < 15; guard++) {
      const parent = byBitrixId.get(cur.parentBitrixId);
      if (!parent) break;
      const uuid = uuidByBitrix.get(parent.bitrixId);
      if (!uuid || seen.has(uuid)) break;
      seen.add(uuid);
      if (!branchesIn.has(uuid)) branchesIn.set(uuid, new Set());
      branchesIn.get(uuid)!.add(r.branch);
      cur = parent;
    }
  }
  const deptIds = new Set<string>();
  const direct = new Set<string>();
  for (const r of rows) {
    if (r.branch !== me.branch || !r.department_id) continue;
    if ((branchesIn.get(r.department_id)?.size ?? 0) > 1) direct.add(r.manager_id); // отдел над филиалами
    else deptIds.add(r.department_id);
  }
  return { deptIds: [...deptIds], directManagerIds: [...direct] };
}

async function branchDepartmentIds(bitrixUserId: string): Promise<string[]> {
  return (await branchScopeFor(bitrixUserId)).deptIds;
}

/** Менеджеры филиала Директора, привязанные напрямую к отделу над филиалами (см. branchScopeFor). */
export async function branchDirectManagerIds(session: SessionUser): Promise<string[]> {
  if (session.roleName !== 'Директор' || !session.bitrixUserId) return [];
  return (await branchScopeFor(session.bitrixUserId)).directManagerIds;
}

export async function canViewManager(session: SessionUser, managerBitrixId: string): Promise<boolean> {
  if (session.bitrixUserId && session.bitrixUserId === managerBitrixId) return true;
  if (hasFullManagerAccess(session)) return true;
  if ((await branchDirectManagerIds(session)).includes(managerBitrixId)) return true;
  const deptIds = await managedDepartmentIds(session);
  if (deptIds.length === 0) return false;
  const roster = await resolveManagersForDepartments(deptIds);
  return roster.some(m => m.managerId === managerBitrixId);
}

/**
 * Пускать ли к «отделочным» данным (карточка отдела, ФИФА-грид).
 *
 * Раньше это была проверка ТОЛЬКО по названию роли (РОП/Директор/Администратор), и
 * с автосозданием аккаунтов из Битрикса она ломалась: РОП, которого ещё нет в
 * приложении, получает роль «Пользователь» — страница по оргструктуре открывает ему
 * режим отдела, а API отвечал 403. Поэтому право теперь даёт и ФАКТИЧЕСКОЕ
 * руководство отделом по структуре «Контроля звонков» — тот же источник, по которому
 * страница и решает, что показать. Роль остаётся как ручной рычаг для тех, кто
 * руководит не по структуре.
 */
export async function canViewDepartmentData(session: SessionUser): Promise<boolean> {
  if (hasFullManagerAccess(session) || session.roleName === 'РОП') return true;
  if (!session.bitrixUserId) return false;
  return (await getCallControlManagedDepts(session.bitrixUserId)).length > 0;
}

/** Для API-роутов: Response 403 либо null, если доступ есть. Сессию проверяет вызывающий. */
export async function managerAccessError(
  session: SessionUser,
  managerBitrixId: string,
): Promise<Response | null> {
  if (await canViewManager(session, managerBitrixId)) return null;
  return Response.json({ error: 'Карточка этого сотрудника вам недоступна' }, { status: 403 });
}

/** Тот же вопрос для набора менеджеров (план/факт и графики принимают список). */
export async function filterViewableManagers(
  session: SessionUser,
  managerBitrixIds: string[],
): Promise<string[]> {
  if (hasFullManagerAccess(session)) return managerBitrixIds;
  const allowed = new Set<string>();
  if (session.bitrixUserId) allowed.add(session.bitrixUserId);
  for (const id of await branchDirectManagerIds(session)) allowed.add(id);
  const deptIds = await managedDepartmentIds(session);
  if (deptIds.length > 0) {
    for (const m of await resolveManagersForDepartments(deptIds)) allowed.add(m.managerId);
  }
  return managerBitrixIds.filter(id => allowed.has(id));
}
