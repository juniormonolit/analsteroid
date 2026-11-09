import { LogistKanbanPage } from '@/features/logist-kanban/ui/LogistKanbanPage';

export const metadata = {
  title: 'Канбан логиста — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default function Page() {
  return <LogistKanbanPage />;
}
