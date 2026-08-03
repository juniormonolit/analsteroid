import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Раздел «Боты» — гейт section.settings (как «Шаблоны карточек»: админ видит и
// меняет, супер-админ не обязателен — решение Иосифа 13.07). Пользователи только
// с action.users.manage (вход в /settings ради «Пользователей») сюда не попадают.
// Задача 2824: молчаливый redirect('/settings') заменён на явное сообщение —
// иначе ссылка на раздел без прав у получателя тихо уводит на хаб настроек.
export default async function BotsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.settings')) {
    return <AccessDenied reason="Раздел «Боты» доступен только с правом «Настройки» — попросите администратора выдать его в настройках ролей." />;
  }
  return <>{children}</>;
}
