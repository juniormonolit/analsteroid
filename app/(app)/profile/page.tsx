import { ProfilePage } from '@/features/profile/ui/ProfilePage';

// ЛК доступен любому залогиненному пользователю — гейт по правам не нужен
// (сессию проверяет app/(app)/layout.tsx).
export default function Page() {
  return <ProfilePage />;
}
