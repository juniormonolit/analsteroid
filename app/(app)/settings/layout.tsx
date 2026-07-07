import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { SettingsSidebar } from './SettingsSidebar';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isAdmin) redirect('/');

  return (
    // Телефон: навигация настроек — горизонтальные табы над контентом; md+: сайдбар слева
    <div className="flex flex-col md:flex-row h-full overflow-hidden">
      <aside className="md:w-48 shrink-0 border-b md:border-b-0 md:border-r border-[var(--color-border)] bg-[var(--color-bg-surface)] flex flex-col">
        <div className="px-4 py-3 border-b border-[var(--color-border)] hidden md:block">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Настройки</h2>
        </div>
        <nav className="flex md:flex-col md:flex-1 py-1.5 md:py-2 overflow-x-auto">
          <SettingsSidebar />
        </nav>
      </aside>
      <div className="flex-1 overflow-auto min-w-0">
        {children}
      </div>
    </div>
  );
}
