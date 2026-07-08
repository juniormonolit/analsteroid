import { PlansPage } from '@/features/plans/ui/PlansPage';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';

export default async function Page() {
  const session = await getSession();
  return <PlansPage canEdit={hasPerm(session, 'action.plans.edit')} />;
}
