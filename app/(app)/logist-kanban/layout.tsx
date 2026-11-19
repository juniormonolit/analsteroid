import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { canViewLogistKanban } from '@/features/logist-kanban/engine/access';
import { profileNavProps } from '../profile/profileNavProps';
import { LkNavInBitrix } from '../repeat-kanban/LkNavInBitrix';

// Гейт «Канбана логиста» (запросы логистам, LOGIST_REQUESTS_SPEC.md): роль «Логист» (section.logist_kanban),
// админ или руководитель логистики. Менеджеры свои запросы смотрят в «Моих запросах» ЛК, не здесь.
// Внутри Битрикса — с меню ЛК, как повторка (LkNavInBitrix).
export default async function LogistKanbanLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!canViewLogistKanban(session)) {
    return <AccessDenied reason="Канбан логиста открыт роли «Логист», руководителю логистики и администраторам." />;
  }
  return <LkNavInBitrix nav={await profileNavProps(session)}>{children}</LkNavInBitrix>;
}
