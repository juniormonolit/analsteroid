import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { NotificationsPage } from '@/features/profile/ui/NotificationsPage';

// «Уведомления» (правка владельца 05.08): раздел вместо висящего колокольчика.
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  // Раздел скрыт для всех, кроме супер-админов (решение владельца 17.09).
  if (!session.isSuperadmin) redirect('/profile?tab=customers');
  return <NotificationsPage />;
}
