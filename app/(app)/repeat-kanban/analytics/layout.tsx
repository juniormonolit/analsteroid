import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { canSeeKanbanAnalytics } from '@/features/repeat-kanban/engine/analyticsAccess';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Аналитика канбана повторных — РОПам и выше (владелец 28.10; было — директорам, 20.10). Данные — по зоне РОПа.
export default async function RepeatKanbanAnalyticsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!(await canSeeKanbanAnalytics(session))) {
    return <AccessDenied reason="Аналитика канбана повторных открыта РОПам и выше." />;
  }
  return <>{children}</>;
}
