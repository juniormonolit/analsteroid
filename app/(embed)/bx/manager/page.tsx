import { getSession } from '@/lib/auth/session';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';
import { hasPerm } from '@/lib/auth/perms';
import { ManagerCardPage } from '@/features/manager-card/ui/ManagerCardPage';

// ЛК внутри Битрикса. Логика «чью карточку показать» — ровно та же, что на
// /manager/me (РОП/директор видит агрегат своих отделов по структуре «Контроля
// звонков», менеджер — себя): личность берём ТОЛЬКО из сессии, которую завёл
// обработчик /api/bitrix/app по токену от портала. Никаких id из URL — иначе
// сотрудник открыл бы карточку коллеги, поправив адрес.
//
// Багфикс (аудит мобильной готовности, задача 2764): эта страница написана
// 30.07, ДО системы наград (showBadges/isSelf, задача 2655, 31.07) — при
// добавлении наград проп showBadges забыли протащить сюда же, хотя на
// /manager/me он есть с самого начала фичи. Без него ManagerCardPage считает
// свой же кабинет ЧУЖИМ (isSelf=showBadges=false): пропадают кнопки
// «Обменять»/«Вывести в ЗП» в рублёвом кошельке, перевод MLT коллеге, крутка
// гачи, реролл квеста, активация/подарок предмета в инвентаре — весь ЛК внутри
// Битрикса становится «только читать». showBadges теперь передаётся в обеих
// ветках, как на /manager/me.
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
    // Прямая ссылка на настройки пользователей (задача 2771). target="_blank"
    // ОБЯЗАТЕЛЕН здесь: /settings/users вне /bx/* запрещён к фреймингу (CSP
    // frame-ancestors в next.config.ts) — обычная ссылка внутри iframe портала
    // просто не отрисуется (пустой фрейм), нужна навигация в новой вкладке.
    const canFix = hasPerm(session, 'action.users.manage');
    return (
      <div className="p-6 text-sm text-[var(--color-text-muted)] max-w-md mx-auto text-center">
        Аккаунт не связан с Битриксом — {canFix ? (
          <>
            укажите Bitrix ID в{' '}
            <a href="/settings/users" target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline font-semibold">
              настройках пользователей
            </a>{' '}(откроется в новой вкладке — здесь, внутри Битрикса, эта страница не встраивается),
          </>
        ) : (
          'попросите администратора указать Bitrix ID в настройках пользователей,'
        )} и здесь появится ваш кабинет.
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
        showBadges
      />
    );
  }
  return <ManagerCardPage managerId={session.bitrixUserId} mode="manager" managerName={session.displayName} showBadges />;
}
