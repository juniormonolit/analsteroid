import 'server-only';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';
import type { SessionUser } from '@/lib/auth/session';

// «Чей кабинет показать» — ОДНО решение для всех входов в ЛК (задача 3045, п.10
// «что сломается»: `/profile` и `/bx/manager` иначе становятся двумя реализациями
// одного экрана и разъезжаются — это уже случалось живьём, см. багфикс про
// забытый `showBadges` в шапке `app/(embed)/bx/manager/page.tsx`).
//
// Правило (решение владельца 29.07): РОП/директор видит агрегат своих отделов по
// оргструктуре робота «Контроль звонков» (ручные назначения приоритетнее битриксовой
// структуры), рядовой менеджер — собственную карточку.
//
// Личность берётся ТОЛЬКО из сессии, никаких id из URL: иначе, поправив адрес,
// сотрудник открыл бы кабинет коллеги.
export type SelfCard =
  | { kind: 'no-bitrix' }
  | { kind: 'card'; managerId: string; mode: 'manager' | 'department'; managerName: string };

export async function resolveSelfCard(session: SessionUser): Promise<SelfCard> {
  if (!session.bitrixUserId) return { kind: 'no-bitrix' };

  const managed = await getCallControlManagedDepts(session.bitrixUserId);
  if (managed.length > 0) {
    return {
      kind: 'card',
      managerId: 'my',
      mode: 'department',
      managerName: managed.length === 1 ? (managed[0].deptName ?? 'Мой отдел') : `Мои отделы (${managed.length})`,
    };
  }
  return { kind: 'card', managerId: session.bitrixUserId, mode: 'manager', managerName: session.displayName };
}
