import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { canViewBigBrother } from '@/lib/activity/access';
import { UsagePage } from '@/features/big-brother/ui/usage/UsagePage';

// «Большой брат» → «Использование» (поток E). Гейт продублирован (layout раздела делает свой).
export const dynamic = 'force-dynamic';

export default async function BigBrotherUsagePage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!canViewBigBrother(session)) return <AccessDenied reason="«Использование Монолитики» — директорам и администраторам." />;
  return <UsagePage />;
}
