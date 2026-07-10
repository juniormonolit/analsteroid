import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';

// Права v2 — см. пояснение в ../tables/layout.tsx (та же причина).
export default async function SettingsMetricColorsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.settings')) redirect('/settings');
  return <>{children}</>;
}
