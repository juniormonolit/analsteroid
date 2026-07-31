import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { EmployeesPage } from '@/features/employees/ui/EmployeesPage';

export const metadata = { title: 'Сотрудники — Аналстероид' };

// Серверный гейт (в дополнение к permError в API): без права section.employees
// прямой заход по URL не показывает даже каркас раздела.
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.employees')) {
    return (
      <div className="p-6 text-sm text-[var(--color-text-muted)]">
        Раздел «Сотрудники» закрыт — попросите администратора выдать право
        в настройках ролей.
      </div>
    );
  }
  return <EmployeesPage />;
}
