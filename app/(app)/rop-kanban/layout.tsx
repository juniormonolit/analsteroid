import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasRopKanbanPilot } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Гейт скрытого пилота «Канбан РОПа» (задача #9625): личный доступ, не роль. Честное
// «недостаточно прав» на том же адресе (правило Серёги), а не редирект/404.
export default async function RopKanbanLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasRopKanbanPilot(session)) {
    return <AccessDenied reason="Канбан РОПа — закрытый пилот. Доступ выдаётся лично, не по роли." />;
  }
  return <>{children}</>;
}
