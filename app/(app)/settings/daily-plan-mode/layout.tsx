import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

// Режим дневного плана (п.7 спеки, решение собрания 08.07) — ТОЛЬКО супер-админ (Серёга).
// Роль «Администратор» (section.settings) сюда доступа не имеет, как и /settings/roles.
export default async function DailyPlanModeLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isSuperadmin) redirect('/settings');
  return <>{children}</>;
}
