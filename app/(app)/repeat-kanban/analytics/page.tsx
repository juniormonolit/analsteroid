import { RepeatKanbanAnalyticsPage } from '@/features/repeat-kanban/ui/RepeatKanbanAnalyticsPage';

export const metadata = {
  title: 'Аналитика канбана повторных — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default function Page() {
  return <RepeatKanbanAnalyticsPage />;
}
