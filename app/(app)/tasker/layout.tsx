import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { profileNavProps } from '../profile/profileNavProps';
import { LkNavInBitrix } from '../repeat-kanban/LkNavInBitrix';

// Гейт «Задачника» (TASKER_SPEC.md): право section.tasker — на весь раздел, включая /tasker/trainings.
// Честное «недостаточно прав» на том же адресе. Внутри Битрикса — с меню ЛК, как канбан повторных.
export default async function TaskerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.tasker')) {
    return <AccessDenied reason="Задачник открыт ролям продаж (РОП, менеджер, директор)." />;
  }
  return <LkNavInBitrix nav={await profileNavProps(session)}>{children}</LkNavInBitrix>;
}
