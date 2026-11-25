// «Большой брат» — кто видит раздел (решение владельца 25.11, BIG_BROTHER_SPEC.md «Доступ»).
// Без серверных зависимостей — импортируется и в AppShell (клиент).
import type { SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';

type S = Pick<SessionUser, 'isSuperadmin' | 'roleName' | 'permissions'> | null | undefined;

const isAdmin = (s: NonNullable<S>) => s.isSuperadmin || s.roleName === 'Администратор';

/** Раздел целиком: «директор и выше» (superadmin / Администратор / роль Директор) или явное право section.big_brother. */
export function canViewBigBrother(s: S): boolean {
  if (!s) return false;
  return isAdmin(s) || s.roleName === 'Директор' || hasPerm(s as SessionUser, 'section.big_brother');
}

/** Вкладка «РОПы» (рейтинг РОПов): только админы или пофамильное action.big_brother_rop. */
export function canViewBigBrotherRop(s: S): boolean {
  if (!s) return false;
  return isAdmin(s) || s.permissions.includes('action.big_brother_rop');
}
