import type { SessionUser } from './session';
import { hasPerm } from './perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

/** Доступ к API раздела «Модули» — зеркало гейта app/(app)/modules/layout.tsx. */
export function canUseModules(session: SessionUser): boolean {
  return hasFullManagerAccess(session) || hasPerm(session, 'section.modules');
}
