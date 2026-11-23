import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { getSessionScope } from '@/lib/org/sessionScope';
import { MetricMapPage } from '@/features/metric-map/ui/MetricMapPage';

// Уровень доступа нужен экрану только для набора срезов в фильтре (МОП — только «я»);
// сами данные режет срезом сессии API /api/metric-map.
export default async function MetricMapRoute() {
  const session = await getSession();
  if (!session) redirect('/login');
  const scope = await getSessionScope(session);
  return <MetricMapPage access={scope.kind} selfId={session.bitrixUserId} selfName={session.displayName} />;
}
