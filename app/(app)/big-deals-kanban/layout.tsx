import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { profileNavProps } from '../profile/profileNavProps';
import { LkNavInBitrix } from '../repeat-kanban/LkNavInBitrix';

// Гейт «Канбана больших чеков» (решения владельца 18.11): то же право, что у канбана повторных
// (section.repeat_kanban — роли продаж). Внутри Битрикса — с меню ЛК, как повторка (LkNavInBitrix).
export default async function BigDealsKanbanLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.repeat_kanban')) {
    return <AccessDenied reason="Канбан больших чеков открыт ролям продаж (РОП, менеджер, директор)." />;
  }
  return <LkNavInBitrix nav={await profileNavProps(session)}>{children}</LkNavInBitrix>;
}
