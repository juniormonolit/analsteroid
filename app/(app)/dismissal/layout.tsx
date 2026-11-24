import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { canUseDismissal } from '@/features/dismissal/access';

// Гейт «Увольнятора» (владелец 24.11): только Администратор, Директор и суперадмин.
export default async function DismissalLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!canUseDismissal(session)) {
    return <AccessDenied reason="«Увольнятор» доступен только администраторам и директорам." />;
  }
  return <>{children}</>;
}
