import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { TrainingsPage } from '@/features/tasker/trainings/ui/TrainingsPage';

export const metadata = {
  title: 'Обучения — Задачник — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

// Свой гейт на случай, если layout Задачника (сессия A) ещё не выкачен; дублирование безвредно.
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.tasker')) return <AccessDenied reason="Задачник открыт ролям продаж." />;
  return <TrainingsPage />;
}
