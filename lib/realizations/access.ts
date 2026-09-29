import type { SessionUser } from '../auth/session';

// Доступ к «Продажи → Реализация» (задача #8034, просьба Сергея 29.09): ТОЛЬКО
// роль «Администратор» (и супер-админ, который выше любой роли). Сознательно НЕ
// hasPerm('section.realization'): право из матрицы выдаётся любой роли, а
// джокер section.* у роли — не то же самое, что «Администратор». Функция без
// импортов БД — ей пользуются и сайдбар (клиент), и layout раздела, и все API
// /api/realizations/* — одна проверка на три слоя.
export const REALIZATIONS_ROLE = 'Администратор';

export function canViewRealizations(session: Pick<SessionUser, 'isSuperadmin' | 'roleName'> | null | undefined): boolean {
  if (!session) return false;
  return session.isSuperadmin === true || session.roleName === REALIZATIONS_ROLE;
}
