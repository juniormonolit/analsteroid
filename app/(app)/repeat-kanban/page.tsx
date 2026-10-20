import { RepeatKanbanPage } from '@/features/repeat-kanban/ui/RepeatKanbanPage';

export const metadata = {
  title: 'Канбан повторных продаж — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default function Page() {
  return <RepeatKanbanPage />;
}
