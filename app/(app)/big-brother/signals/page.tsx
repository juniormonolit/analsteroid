import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { canViewBigBrother } from '@/lib/activity/access';
import { SignalsPage } from '@/features/big-brother/ui/signals/SignalsPage';

// «Большой брат» → «Сигналы»: сигналы риска (подсказка директору), реакция на бота, настройки еженедельного дайджеста.
export default async function BigBrotherSignalsRoute() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!canViewBigBrother(session)) return <AccessDenied reason="Раздел «Большой брат» — для уровня «директор и выше»." />;
  return <SignalsPage />;
}
