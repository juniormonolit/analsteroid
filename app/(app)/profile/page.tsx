import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { resolveSelfCard } from '@/lib/org/selfCard';
import { ManagerCardPage } from '@/features/manager-card/ui/ManagerCardPage';

// `/profile` — ЛК (задача 3045, §1). Раньше по этому адресу жили настройки профиля,
// а кабинет висел на `/manager/me`; теперь наоборот: кабинет здесь, личные настройки
// уехали на `/profile/settings`, `/manager/me` стал редиректом. Совместимость старых
// ссылок не делаем — решение владельца (§«Старые адреса»).
//
// Решение «чью карточку показать» вынесено в `lib/org/selfCard.ts` и общее с
// `/bx/manager` (п.10 спеки).
export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');

  const self = await resolveSelfCard(session);

  if (self.kind === 'no-bitrix') {
    // Ссылку на настройки показываем только тем, кто реально может дойти (тот же
    // гейт, что у API управления пользователями) — иначе тупик «нет прав» вместо
    // «нет ЛК». Задача 2771: Серёга сам попал в этот текст, зайдя админом без
    // привязки к Битриксу.
    const canFix = hasPerm(session, 'action.users.manage');
    return (
      <div className="p-6 text-sm text-[var(--color-text-muted)]">
        Аккаунт не связан с Битриксом — {canFix ? (
          <>
            укажите Bitrix ID в <Link href="/settings/users" className="text-[var(--color-accent)] hover:underline font-semibold">настройках пользователей</Link>,
          </>
        ) : (
          'попросите администратора указать Bitrix ID в настройках пользователей,'
        )} и здесь появится ваш ЛК. Личные настройки доступны и без этого — вкладка «Настройки» выше.
      </div>
    );
  }

  return (
    <ManagerCardPage
      managerId={self.managerId}
      mode={self.mode}
      managerName={self.managerName}
      showBadges
      externalNav
    />
  );
}
