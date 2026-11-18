// Кто нажал и что ему можно — для действий и карточки задачи канбана больших чеков (зона как у канбана повторных).
import type { SessionUser } from '@/lib/auth/session';
import { ropScope } from '@/features/tv/engine/access';
import { scopeManagers } from '@/features/rop-kanban/engine/kanban';
import type { BigActor } from './actions';

export async function bigActor(session: SessionUser): Promise<BigActor> {
  const scope = await ropScope(session);
  if (scope.full) return { userId: session.bitrixUserId, name: session.displayName ?? null, canManage: true, zone: 'all' };
  const managers = await scopeManagers(scope);
  const canManage = !scope.selfOnly && managers.some(m => m.id !== session.bitrixUserId);
  const zone = new Set(managers.map(m => m.id));
  if (session.bitrixUserId) zone.add(session.bitrixUserId);
  return { userId: session.bitrixUserId, name: session.displayName ?? null, canManage, zone };
}

