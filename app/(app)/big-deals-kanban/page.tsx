import { BigDealsKanbanPage } from '@/features/big-deals-kanban/ui/BigDealsKanbanPage';

export const metadata = {
  title: 'Канбан больших чеков — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default function Page() {
  return <BigDealsKanbanPage />;
}
