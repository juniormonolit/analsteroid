import type { SessionUser } from '@/lib/auth/session';
import { getCallControlManagedDepts } from './callControlScope';
import { getUserDepartmentOptions, resolveManagersForDepartments } from './teamRoster';
import { analyticsDb } from '@/lib/db/clients';

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
 */
async function branchDepartmentIds(bitrixUserId: string): Promise<string[]> {
  const res = await analyticsDb().query<{ department_id: string }>(
    `SELECT DISTINCT department_id::text AS department_id
       FROM sa.org_resolved_hierarchy
      WHERE is_active AND department_id IS NOT NULL
        AND branch IS NOT DISTINCT FROM (
          SELECT branch FROM sa.org_resolved_hierarchy
           WHERE manager_bitrix_user_id::text = $1 AND is_active LIMIT 1)
        AND EXISTS (SELECT 1 FROM sa.org_resolved_hierarchy o2
                     WHERE o2.manager_bitrix_user_id::text = $1 AND o2.is_active)`,
    [bitrixUserId],
  );
  return res.rows.map(r => r.department_id);
}

export async function canViewManager(session: SessionUser, managerBitrixId: string): Promise<boolean> {
  if (session.bitrixUserId && session.bitrixUserId === managerBitrixId) return true;
  if (hasFullManagerAccess(session)) return true;
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
  const deptIds = await managedDepartmentIds(session);
  if (deptIds.length > 0) {
    for (const m of await resolveManagersForDepartments(deptIds)) allowed.add(m.managerId);
  }
  return managerBitrixIds.filter(id => allowed.has(id));
}
