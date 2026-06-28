import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { SettingsSidebar } from './SettingsSidebar';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isAdmin) redirect('/');

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-48 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg-surface)] flex flex-col">
        <div className="px-4 py-3 border-b border-[var(--color-border)]">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Настройки</h2>
        </div>
        <nav className="flex-1 py-2">
          <SettingsSidebar />
        </nav>
      </aside>
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}
