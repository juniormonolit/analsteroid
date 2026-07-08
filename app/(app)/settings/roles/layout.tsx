import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

// Настройка ролей и прав — ТОЛЬКО супер-админ (аккаунт admin).
// Роль «Администратор» сюда доступа не имеет.
export default async function SettingsRolesLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isSuperadmin) redirect('/settings');
  return <>{children}</>;
}
