import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

// Вкладка «Награды» — админский паттерн roles: только супер-админ.
export default async function RewardsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isSuperadmin) redirect('/settings');
  return <>{children}</>;
}
