import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { canManageIdleWatch } from '@/features/big-brother/ui/watch/access';
import { IdleWatchSettings } from '@/features/big-brother/ui/watch/IdleWatchSettings';

// «Большой брат» → «Сторож»: настройки сторожа МОПов (движок lib/bots/idleWatch.ts, миграция 295).
// Гейт продублирован (layout раздела делает свой): директор и выше.
export const dynamic = 'force-dynamic';

export default async function BigBrotherWatchPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!canManageIdleWatch(session)) {
    return <AccessDenied reason="Настройки сторожа МОПов — директорам и администраторам." />;
  }
  return <IdleWatchSettings />;
}
