import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

// Гейт пункта меню «Ещё» (задача Иосифа 10.09): администратор (аудит 09.09)
// ИЛИ явное право роли из «Настройки → Матрица прав» (таблица «Пункты меню
// „Ещё“»). Данные внутри раздела всё равно режутся срезом сессии там, где он есть.
export default async function YearWeeklyLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.year_weekly')) {
    return <AccessDenied reason="Раздел «Данные по годам» — понедельный отчёт год к году. Доступ выдаёт администратор в «Настройки → Матрица прав»." />;
  }
  return <>{children}</>;
}
