import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm, firstAllowedPath } from '@/lib/auth/perms';

export default async function SummaryLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.summary')) redirect(firstAllowedPath(session));
  return <>{children}</>;
}
