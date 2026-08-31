import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { YearWeeklyPage } from '@/features/year-weekly/ui/YearWeeklyPage';

// Спец-отчёт «Данные по годам». Серверный гейт — в дополнение к permError в
// API: прямой заход по URL без права не показывает даже каркас (паттерн offload).
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.year_weekly')) {
    return (
      <div className="p-6 text-sm text-[var(--color-text-muted)]">
        Раздел «Данные по годам» закрыт. Попросите администратора выдать право
        «Данные по годам» вашей роли в «Настройки → Роли».
      </div>
    );
  }
  return <YearWeeklyPage isSuperadmin={session.isSuperadmin} />;
}
