import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

// Матрица прав (Права v2) — ТОЛЬКО супер-админ, как /settings/roles и
// /settings/daily-plan-mode. Роль «Администратор» (section.settings) сюда
// доступа не имеет.
export default async function RightsMatrixLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isSuperadmin) redirect('/settings');
  return <>{children}</>;
}
