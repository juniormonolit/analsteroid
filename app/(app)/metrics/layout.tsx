import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm, firstAllowedPath } from '@/lib/auth/perms';

// До RBAC у /metrics не было серверного гейта вообще (страница только пряталась из сайдбара).
export default async function MetricsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.metrics')) redirect(firstAllowedPath(session));
  return <>{children}</>;
}
