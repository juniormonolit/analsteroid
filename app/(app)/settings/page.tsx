import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';

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

  // Задача 3045, шаг 1. Здесь БЫЛ `redirect(firstAllowedPath(session))` как
  // «страховка, не должно случиться» — и он бы ТИХО СЛОМАЛ честный отказ из
  // layout.tsx: Next исполняет page даже когда layout отбрасывает children
  // (страница приходит в layout пропом), а `redirect()` бросает исключение и
  // перебивает решение layout'а. То есть человек без прав всё равно уезжал бы
  // на /home вместо сообщения. Отдаём тот же AccessDenied.
  return (
    <AccessDenied reason="Системные настройки приложения — метрики, таблицы, роли, боты. Доступ выдаёт администратор в «Настройки → Роли»." />
  );
}
