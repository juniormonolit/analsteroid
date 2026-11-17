import type { SessionUser } from '@/lib/auth/session';
import { resolveSelfCard } from '@/lib/org/selfCard';
import { hasPerm } from '@/lib/auth/perms';
import { hasFullManagerAccess, managedDepartmentIds } from '@/lib/org/managerAccess';

/** Что нужно рельсе/шторке ЛК (ProfileRail / ProfileMobileNav). Считает сервер. */
export interface ProfileNavProps {
  mode: 'manager' | 'department' | 'none';
  canManageRequests: boolean;
  restricted: boolean;
  canRepeatKanban: boolean;
}

// Один расчёт на два места: лейаут ЛК (/profile/*) и канбан повторных внутри Битрикса
// (/repeat-kanban/*, см. LkNavInBitrix — 17.11: там нет адресной строки, а без меню ЛК из канбана было не уйти).
export async function profileNavProps(session: SessionUser): Promise<ProfileNavProps> {
  const self = await resolveSelfCard(session);
  return {
    mode: self.kind === 'no-bitrix' ? 'none' : self.mode,
    // «Заявки» в рельсе — только тем, кому есть что решать (руководство/РОП).
    canManageRequests: hasFullManagerAccess(session) || (await managedDepartmentIds(session)).length > 0,
    // Решение владельца 17.09: всем, кроме супер-админов, в ЛК видны только «Мой отчёт»,
    // «Статистика», «Мой отдел» (РОП и старше), «Канбан повторных» (с 17.11 вместо «Мои заказчики»), «Настройки». Остальное
    // (профиль, награды, кошелёк, магазин, квесты, движуха, коллеги…) — скрыто; страницы
    // этих разделов редиректят сами (см. page.tsx каждого).
    restricted: !session.isSuperadmin,
    // «Канбан повторных» вместо «Мои заказчики» (17.11) — только тем, кому канбан открыт.
    canRepeatKanban: hasPerm(session, 'section.repeat_kanban'),
  };
}
