import type { SessionUser } from '@/lib/auth/session';

/** «Увольнятор» — только Администратор, Директор и суперадмин (владелец 24.11). Права в матрице
 *  нет намеренно: инструмент массово переписывает чужие сделки и задачи. Клиентский импорт
 *  безопасен — модуль без серверных зависимостей (используется и в меню AppShell). */
export function canUseDismissal(session: Pick<SessionUser, 'isSuperadmin' | 'roleName'> | null | undefined): boolean {
  if (!session) return false;
  return session.isSuperadmin || session.roleName === 'Администратор' || session.roleName === 'Директор';
}
