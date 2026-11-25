// «Большой брат» — гейты доступа потока B (дублируют lib/activity/access.ts потока A, чтобы API и страницы
// не зависели от порядка коммитов; решение владельца 25.11, BIG_BROTHER_SPEC.md «Доступ»).
// Без серверных зависимостей — импортируется и в клиентских страницах.
import type { SessionUser } from '@/lib/auth/session';

type S = Pick<SessionUser, 'isSuperadmin' | 'roleName' | 'permissions'> | null | undefined;

const isAdmin = (s: NonNullable<S>) => s.isSuperadmin || s.roleName === 'Администратор';

/** Рейтинг РОПов: только superadmin / Администратор или пофамильное право action.big_brother_rop. */
export function canViewRopRating(s: S): boolean {
  return !!s && (isAdmin(s) || s.permissions.includes('action.big_brother_rop'));
}

/** Дисциплина задач (раздел целиком): «директор и выше» или явное section.big_brother. */
export function canViewTaskDiscipline(s: S): boolean {
  return !!s && (isAdmin(s) || s.roleName === 'Директор' || s.permissions.includes('section.big_brother'));
}
