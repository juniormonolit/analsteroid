import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Матрица прав (Права v2) — ТОЛЬКО супер-админ, как /settings/roles и
// /settings/daily-plan-mode. Роль «Администратор» (section.settings) сюда
// доступа не имеет.
// Задача 2824: молчаливый redirect('/settings') заменён на явное сообщение.
export default async function RightsMatrixLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isSuperadmin) {
    return <AccessDenied reason="Матрица прав — раздел только для супер-администратора." />;
  }
  return <>{children}</>;
}
