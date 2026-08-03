import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Права v2 — см. пояснение в ../tables/layout.tsx (та же причина).
// Задача 2824: молчаливый redirect('/settings') заменён на явное сообщение.
export default async function SettingsMetricsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.settings')) {
    return <AccessDenied reason="Раздел «Метрики» доступен только с правом «Настройки» — попросите администратора выдать его в настройках ролей." />;
  }
  return <>{children}</>;
}
