import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { PeoplePage } from '@/features/profile/ui/PeoplePage';

// «Люди» (задача владельца 05.08, ЛК-соцсетка): поиск сотрудников и переход в
// публичные профили. Как и весь кабинет — доступно любому залогиненному,
// см. комментарий в ../layout.tsx.
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  // Раздел скрыт для всех, кроме супер-админов (решение владельца 17.09).
  if (!session.isSuperadmin) redirect('/profile?tab=customers');
  return <PeoplePage />;
}
