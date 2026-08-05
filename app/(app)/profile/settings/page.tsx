import { ProfileSettingsPage } from '@/features/profile/ui/ProfileSettingsPage';

// Личные настройки — «настройки себя» (задача 3045, §1). Правами не гейтятся: доступны
// любому залогиненному, включая аккаунт без единого section.*-права. Именно поэтому они
// НЕ уехали в /settings/* — тот раздел закрыт правом section.settings, и, положив туда
// смену пароля с уведомлениями, мы отобрали бы их у всех рядовых (§1, отступление
// архитектора от формулировки владельца — принято).
export default function Page() {
  return <ProfileSettingsPage />;
}
