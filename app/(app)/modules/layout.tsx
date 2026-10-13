import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

// Гейт пункта «Ещё» → «Модули» (ТЗ владельца 13.10): администратор ИЛИ явное
// право роли из «Настройки → Матрица прав». Тот же паттерн, что у «Виджетов».
export default async function ModulesLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.modules')) {
    return <AccessDenied reason="Раздел «Модули» — превью модулей для Битрикса. Доступ выдаёт администратор в «Настройки → Матрица прав»." />;
  }
  return <>{children}</>;
}
