import type { SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';

// «Канбан логиста»: роль «Логист» (право section.logist_kanban, миграция 261) ИЛИ
// админ/супер-админ — как остальные пункты «Ещё» (canMore в AppShell).
export function canViewLogistKanban(s: SessionUser | null): boolean {
  if (!s) return false;
  return s.isSuperadmin || s.roleName === 'Администратор' || hasPerm(s, 'section.logist_kanban');
}
