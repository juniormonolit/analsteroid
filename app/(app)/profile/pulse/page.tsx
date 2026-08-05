import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { PulsePage } from '@/features/profile/ui/PulsePage';

// «Движуха» (задача владельца 05.08): общая лента компании. Как и весь
// кабинет — любому залогиненному, см. ../layout.tsx.
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  return <PulsePage />;
}
