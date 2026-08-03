import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Вкладка «Награды» — админский паттерн roles: только супер-админ.
// Задача 2824: молчаливый redirect('/settings') заменён на явное сообщение.
export default async function RewardsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isSuperadmin) {
    return <AccessDenied reason="Раздел «Геймификация» — только для супер-администратора." />;
  }
  return <>{children}</>;
}
