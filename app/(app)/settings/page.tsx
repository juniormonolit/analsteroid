import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm, firstAllowedPath } from '@/lib/auth/perms';

// Права v2: вход в /settings теперь возможен и без section.settings (только
// с action.users.manage — см. layout.tsx), поэтому дефолтный редирект на
// /settings/metrics больше не универсален: пользователь без section.settings
// туда всё равно не попадёт (metrics/layout.tsx проверяет отдельно) и просто
// увидит редирект в редирект. Ведём на первую реально доступную вкладку.
export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  if (hasPerm(session, 'section.settings')) redirect('/settings/metrics');
  if (hasPerm(session, 'action.users.manage')) redirect('/settings/users');
  // Не должно случиться — layout.tsx уже отсеивает без обоих прав. Страховка.
  redirect(firstAllowedPath(session));
}
