import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { canViewRopRating } from '@/features/big-brother/engine/rop/access';
import { RopRatingPage } from '@/features/big-brother/ui/rop/RopRatingPage';

// «Большой брат» → «РОПы». Гейт продублирован здесь и в API (не зависит от layout раздела).
export default async function BigBrotherRopRoute() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!canViewRopRating(session)) return <AccessDenied reason="Рейтинг РОПов доступен только администраторам." />;
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <RopRatingPage />
    </div>
  );
}
