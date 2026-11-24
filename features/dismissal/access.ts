import type { SessionUser } from '@/lib/auth/session';

/** «Увольнятор» — Администратор, Директор, РОП и суперадмин. РОП добавлен 24.11 (владелец: бот присылает РОПу
 *  черновик увольнения из чата «Увольнения» — «открыть РОПам по иерархии»). Кого можно увольнять и кому раздавать —
 *  режется срезом на сервере (features/dismissal/engine/scope.ts): РОП — только свои подчинённые. Права в матрице
 *  нет намеренно: инструмент массово переписывает чужие сделки и задачи. Клиентский импорт
 *  безопасен — модуль без серверных зависимостей (используется и в меню AppShell). */
export function canUseDismissal(session: Pick<SessionUser, 'isSuperadmin' | 'roleName'> | null | undefined): boolean {
  if (!session) return false;
  return session.isSuperadmin || session.roleName === 'Администратор' || session.roleName === 'Директор' || session.roleName === 'РОП';
}
