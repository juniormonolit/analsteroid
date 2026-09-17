import { ProfileSettingsPage } from '@/features/profile/ui/ProfileSettingsPage';
import { BitrixLeftMenuBlock } from '@/features/profile/ui/BitrixLeftMenuBlock';
import { getSession } from '@/lib/auth/session';

// Личные настройки — «настройки себя» (задача 3045, §1). Правами не гейтятся: доступны
// любому залогиненному, включая аккаунт без единого section.*-права. Именно поэтому они
// НЕ уехали в /settings/* — тот раздел закрыт правом section.settings, и, положив туда
// смену пароля с уведомлениями, мы отобрали бы их у всех рядовых (§1, отступление
// архитектора от формулировки владельца — принято).
export default async function Page() {
  const session = await getSession();
  return (
    <>
      <ProfileSettingsPage />
      {/* Блок супер-админа (17.09): «Монолитика» в левом меню Битрикса для всех. */}
      {session?.isSuperadmin && <div className="px-4 sm:px-6 pb-6 max-w-3xl"><BitrixLeftMenuBlock /></div>}
    </>
  );
}
