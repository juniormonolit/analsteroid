import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';

// Раздел «Боты» — гейт section.settings (как «Шаблоны карточек»: админ видит и
// меняет, супер-админ не обязателен — решение Иосифа 13.07). Пользователи только
// с action.users.manage (вход в /settings ради «Пользователей») сюда не попадают.
export default async function BotsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.settings')) redirect('/settings');
  return <>{children}</>;
}
