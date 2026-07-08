import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { firstAllowedPath } from '@/lib/auth/perms';

export default async function Root() {
  const session = await getSession();
  redirect(firstAllowedPath(session));
}
