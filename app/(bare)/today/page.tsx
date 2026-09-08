import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { TodayDashboard } from '@/features/tv/ui/TodayDashboard';

export const metadata = { title: 'Сегодня по компании — Монолитика' };

export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.tv')) {
    return <AccessDenied reason="Дашборд «Сегодня по компании» открыт тем, у кого есть раздел «Телевизоры». Доступ выдаёт администратор в «Настройки → Роли»." />;
  }
  return <TodayDashboard />;
}
