import { RopKanbanPage } from '@/features/rop-kanban/ui/RopKanbanPage';

export const metadata = {
  title: 'Канбан РОПа — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default function Page() {
  return <RopKanbanPage />;
}
