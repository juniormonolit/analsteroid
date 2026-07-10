import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';

// Права v2: вход в /settings стал доступен и без section.settings (только с
// action.users.manage — см. ../layout.tsx), поэтому «Настройки» в узком
// смысле (Таблицы/Метрики/Цвета/Календарь) теперь нужно гейтить отдельно на
// каждой вкладке — раньше хватало общего гейта на /settings/layout.tsx.
// API-роут (/api/settings/tables) уже был гейтирован section.settings и без
// этого файла — это защита на уровне UI (не даём открыть пустую/ошибочную
// страницу тому, у кого нет section.settings, только action.users.manage).
export default async function SettingsTablesLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.settings')) redirect('/settings');
  return <>{children}</>;
}
