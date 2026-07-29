import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { DealChatsPage } from '@/features/deal-chats/ui/DealChatsPage';

export default async function Page() {
  const session = await getSession();
  if (!session || !hasPerm(session, 'action.deal_chats')) redirect('/');
  return <DealChatsPage />;
}
