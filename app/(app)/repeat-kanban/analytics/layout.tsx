import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { canSeeRepeatKanbanAnalytics } from '@/lib/auth/modulesAccess';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Аналитика канбана повторных — директорам и выше (владелец 20.10).
export default async function RepeatKanbanAnalyticsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!canSeeRepeatKanbanAnalytics(session)) {
    return <AccessDenied reason="Аналитика канбана повторных открыта директорам и выше." />;
  }
  return <>{children}</>;
}
