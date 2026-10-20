import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Гейт «Канбана повторных продаж» (решения владельца 20.10): право section.repeat_kanban
// (ролям продаж — миграция 230). Честное «недостаточно прав» на том же адресе.
export default async function RepeatKanbanLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.repeat_kanban')) {
    return <AccessDenied reason="Канбан повторных продаж открыт ролям продаж (РОП, менеджер, директор)." />;
  }
  return <>{children}</>;
}
