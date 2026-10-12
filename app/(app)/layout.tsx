import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AppShell } from '@/components/layout/AppShell';
import { SIDEBAR_COOKIE } from '@/lib/sidebar-cookie';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  const initialCollapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === '1';

  return <AppShell user={session} initialCollapsed={initialCollapsed}>{children}</AppShell>;
}
