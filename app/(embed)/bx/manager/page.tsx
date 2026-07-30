import { getSession } from '@/lib/auth/session';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';
import { ManagerCardPage } from '@/features/manager-card/ui/ManagerCardPage';

// ЛК внутри Битрикса. Логика «чью карточку показать» — ровно та же, что на
// /manager/me (РОП/директор видит агрегат своих отделов по структуре «Контроля
// звонков», менеджер — себя): личность берём ТОЛЬКО из сессии, которую завёл
// обработчик /api/bitrix/app по токену от портала. Никаких id из URL — иначе
// сотрудник открыл бы карточку коллеги, поправив адрес.
export const metadata = { title: 'Мой кабинет — Монолитика' };

export default async function Page() {
  const session = await getSession();

  // Сессии нет — почти всегда это значит, что браузер зарезал cookie в iframe
  // (третьесторонний контекст). Partitioned-cookie в обработчике решает это в
  // Chrome/Edge/Firefox; Safari может всё равно не пустить.
  if (!session) {
    return (
      <div className="p-6 text-sm text-[var(--color-text-muted)] max-w-md mx-auto text-center">
        <p className="mb-2 font-semibold text-[var(--color-text)]">Не удалось открыть кабинет</p>
        <p>
          Браузер заблокировал вход внутри окна Битрикса. Попробуйте открыть портал
          в Chrome или в приложении Битрикс24 — там кабинет работает. Если не
          помогло, напишите администратору.
        </p>
      </div>
    );
  }

  if (!session.bitrixUserId) {
    return (
      <div className="p-6 text-sm text-[var(--color-text-muted)] max-w-md mx-auto text-center">
        Аккаунт не связан с Битриксом — попросите администратора указать Bitrix ID,
        и здесь появится ваш кабинет.
      </div>
    );
  }

  const managed = await getCallControlManagedDepts(session.bitrixUserId);
  if (managed.length > 0) {
    return (
      <ManagerCardPage
        managerId="my"
        mode="department"
        managerName={managed.length === 1 ? (managed[0].deptName ?? 'Мой отдел') : `Мои отделы (${managed.length})`}
      />
    );
  }
  return <ManagerCardPage managerId={session.bitrixUserId} mode="manager" managerName={session.displayName} />;
}
