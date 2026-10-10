import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

export const metadata = { title: 'Дашборд тест — Аналстероид' };

// Гейт пункта меню «Ещё» — тот же паттерн, что у «Сотрудников»: администратор
// ИЛИ явное право роли из «Настройки → Матрица прав».
export default async function DashboardTestLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.dashboard_test')) {
    return <AccessDenied reason="Раздел «Дашборд тест» — черновик дашборда директора по продажам. Доступ выдаёт администратор в «Настройки → Матрица прав»." />;
  }
  return <>{children}</>;
}
