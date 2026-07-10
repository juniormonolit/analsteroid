import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm, firstAllowedPath } from '@/lib/auth/perms';
import { SettingsSidebar } from './SettingsSidebar';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');

  const canViewSettings = hasPerm(session, 'section.settings');
  const canManageUsers = hasPerm(session, 'action.users.manage');
  // Права v2: вход в /settings — section.settings ИЛИ action.users.manage.
  // Раньше был единственный гейт section.settings, из-за чего «Настройки» и
  // «Пользователи» были неразделимы: убрать у роли section.settings означало
  // потерять и управление пользователями. Теперь это два независимых входа —
  // конкретные вкладки (Таблицы/Метрики/...) внутри всё равно требуют
  // section.settings отдельно (см. их собственные layout.tsx и API-роуты).
  if (!canViewSettings && !canManageUsers && !session.isSuperadmin) redirect(firstAllowedPath(session));

  return (
    // Телефон: навигация настроек — горизонтальные табы над контентом; md+: сайдбар слева
    <div className="flex flex-col md:flex-row h-full overflow-hidden">
      {/* md:w-48→md:w-60 (правка 10.07, msg 500): «Режим дневного плана» и другие
          длинные названия разделов еле влезали в 192px, обрезаясь/переносясь.
          Контентная часть (flex-1 справа) не тронута — растёт колонка НАВИГАЦИИ. */}
      <aside className="md:w-60 shrink-0 border-b md:border-b-0 md:border-r border-[var(--color-border)] bg-[var(--color-bg-surface)] flex flex-col">
        <div className="px-4 py-3 border-b border-[var(--color-border)] hidden md:block">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Настройки</h2>
        </div>
        <nav className="flex md:flex-col md:flex-1 py-1.5 md:py-2 overflow-x-auto">
          <SettingsSidebar
            canViewSettings={canViewSettings}
            canManageUsers={canManageUsers}
            isSuperadmin={session.isSuperadmin}
          />
        </nav>
      </aside>
      <div className="flex-1 overflow-auto min-w-0">
        {children}
      </div>
    </div>
  );
}
