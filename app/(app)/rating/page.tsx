import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { RatingPage } from '@/features/rating/ui/RatingPage';

// Раздел «Рейтинг» (задача владельца 30.07) — доступен любому залогиненному:
// состав строк режется по зоне ответственности внутри /api/rating
// (lib/org/managerAccess.ts), поэтому отдельного права не заводим.
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  return <RatingPage />;
}
