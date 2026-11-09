import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { canViewLogistKanban } from '@/features/logist-kanban/engine/access';

// Гейт «Канбана логиста» (владелец 09.11): роль «Логист» (section.logist_kanban) или админ.
export default async function LogistKanbanLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!canViewLogistKanban(session)) {
    return <AccessDenied reason="Канбан логиста открыт роли «Логист» и администраторам." />;
  }
  return <>{children}</>;
}
