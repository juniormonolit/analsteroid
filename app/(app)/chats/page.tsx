import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { DealChatsPage } from '@/features/deal-chats/ui/DealChatsPage';

// Задача 2824: молчаливый redirect('/') при нехватке action.deal_chats заменён
// на явное сообщение — было неотличимо от «просто открыло главную».
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'action.deal_chats')) {
    return <AccessDenied reason="Раздел «Чаты по сделкам» доступен только с правом «Чаты по сделкам» — попросите администратора выдать его в настройках ролей." />;
  }
  return <DealChatsPage />;
}
