// «Большой брат», поток D — доступ к вкладке «Люди»: раздел целиком (директор и выше, lib/activity/access.ts) +
// срез сессии (lib/org/sessionScope.ts): Директор видит свой филиал и ниже, админ — всех.
import type { SessionUser } from '@/lib/auth/session';
import { canViewBigBrother } from '@/lib/activity/access';
import { getSessionScope, scopeManagerIds } from '@/lib/org/sessionScope';
import { loadMonitoredPeople, type MonitoredPerson } from './people';

export { canViewBigBrother as canViewPeople };

/** Мониторимые люди в срезе сессии. */
export async function scopedPeople(session: SessionUser): Promise<MonitoredPerson[]> {
  const [people, scope] = await Promise.all([loadMonitoredPeople(), getSessionScope(session)]);
  const allow = scopeManagerIds(scope);
  if (!allow) return people;
  const set = new Set(allow);
  return people.filter(p => set.has(p.id));
}
