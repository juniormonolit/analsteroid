import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Задача 3045, шаг 1: молчаливый `redirect(firstAllowedPath(session))` заменён на
// честное «недостаточно прав» НА ТОМ ЖЕ адресе (правило владельца из волны 1,
// задача 2824 — прислали ссылку на закрытый раздел, человек должен прочитать
// причину, а не оказаться неизвестно где). Скрывать пункт в меню и запрещать
// доступ — разные вещи: гейт здесь, на сервере, а не в вёрстке сайдбара.
export default async function SalesLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.sales')) {
    return <AccessDenied reason="Раздел «Продажи» — отчёты по менеджерам, товарам и источникам. Доступ выдаёт администратор в «Настройки → Роли»." />;
  }
  return <>{children}</>;
}
