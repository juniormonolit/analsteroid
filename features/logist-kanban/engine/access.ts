import type { SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { canManageLogistKanban } from './requests/actor';

// Страница «Канбан логиста» (/logist-kanban): роль «Логист» (право section.logist_kanban, миграция 261),
// админ / супер-админ или руководитель логистики (canManageLogistKanban). API канбана открыт всем вошедшим —
// данные режет видимость движка (менеджер создаёт и видит свои запросы через «Мои запросы», не через эту доску).
export function canViewLogistKanban(s: SessionUser | null): boolean {
  if (!s) return false;
  return canManageLogistKanban(s) || hasPerm(s, 'section.logist_kanban');
}
