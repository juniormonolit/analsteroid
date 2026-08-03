import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Настройка ролей и прав — ТОЛЬКО супер-админ (аккаунт admin).
// Роль «Администратор» сюда доступа не имеет.
// Задача 2824: молчаливый redirect('/settings') заменён на явное сообщение.
export default async function SettingsRolesLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isSuperadmin) {
    return <AccessDenied reason="Настройка ролей — раздел только для супер-администратора." />;
  }
  return <>{children}</>;
}
