import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Режим дневного плана (п.7 спеки, решение собрания 08.07) — ТОЛЬКО супер-админ (Серёга).
// Роль «Администратор» (section.settings) сюда доступа не имеет, как и /settings/roles.
// Задача 2824: молчаливый redirect('/settings') заменён на явное сообщение.
export default async function DailyPlanModeLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isSuperadmin) {
    return <AccessDenied reason="Режим дневного плана — раздел только для супер-администратора." />;
  }
  return <>{children}</>;
}
