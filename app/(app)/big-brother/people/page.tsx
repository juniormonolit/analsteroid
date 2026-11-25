import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { canViewBigBrother } from '@/lib/activity/access';
import { PeoplePage } from '@/features/big-brother/ui/people/PeoplePage';

// «Большой брат» → «Люди»: список → лента дня и календарь человека. Гейт продублирован здесь и в API; срез — в API.
export default async function BigBrotherPeopleRoute() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!canViewBigBrother(session)) return <AccessDenied reason="Раздел «Большой брат» — для уровня «директор и выше»." />;
  return <PeoplePage />;
}
