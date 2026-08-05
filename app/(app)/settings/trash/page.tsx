import { getSession } from '@/lib/auth/session';
import { hasPerm, isReportAdmin } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { ReportsTrashCard } from '@/features/reports/ui/ReportsTrashCard';

// Общая корзина отчётов (задача 3045, §4 спеки owners-inbox/monolitika-navigation-3045.md).
// Своего адреса у корзины не было вовсе: единственный путь к восстановлению — вкладка
// «Отчёты» в ЛК (переехала туда 16.07 при чистке левого меню). Здесь она получает
// адрес в настройках системы — это место, где витринные отчёты («Роп монитор»,
// «Смекалочная») восстанавливает администратор.
//
// API НЕ трогаем (решение спеки): GET /api/saved-reports/trash сам решает, что показать —
// свои удалённые видит любой, витринные только по action.shared_reports.manage; тот же
// принцип у POST /restore и DELETE /permanent. Значит гейт этой страницы — про НАВИГАЦИЮ,
// а не про данные: даже если сюда зайдёт админ без права на витрину, чужого он не увидит.
//
// Личная корзина рядового менеджера остаётся в ЛК до появления /profile/settings
// (следующий шаг 3045). Спека требует не убирать вкладку из профиля РАНЬШЕ нового
// адреса — иначе человек, удаливший свой отчёт, не сможет его вернуть; здесь адрес
// появился, но он под правом section.settings, которого у рядового нет, поэтому вкладку
// снимем только когда своей корзине найдётся место в личных настройках.
export default async function ReportsTrashPage() {
  const session = await getSession();
  if (!session) return null; // на /login уводит proxy.ts, тут только страховка типов

  if (!hasPerm(session, 'section.settings')) {
    return (
      <AccessDenied reason="Общая корзина отчётов — раздел системных настроек. Свои удалённые отчёты можно восстановить в личном кабинете." />
    );
  }

  const admin = isReportAdmin(session);

  return (
    <div className="p-3 sm:p-6 max-w-[900px]">
      <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">Корзина отчётов</h1>
      <p className="text-sm text-[var(--color-text-muted)] mb-4">
        {admin
          ? 'Удалённые отчёты — свои личные и витринные («Роп монитор», «Смекалочная»).'
          : 'Здесь только свои удалённые отчёты: восстановление витринных требует права на управление общими отчётами.'}
      </p>
      <ReportsTrashCard />
    </div>
  );
}
