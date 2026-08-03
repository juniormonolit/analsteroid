import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Задача 2824: молчаливый redirect('/settings') заменён на явное сообщение.
export default async function SettingsUsersLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'action.users.manage')) {
    return <AccessDenied reason="Раздел «Пользователи» доступен только с правом «Управление пользователями» — попросите администратора выдать его в настройках ролей." />;
  }
  return <>{children}</>;
}
