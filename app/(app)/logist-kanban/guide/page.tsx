import { GuidePage } from '@/features/repeat-kanban/guide/GuidePage';
import { GUIDE } from '@/features/logist-kanban/guide/content';

// «Как работать?» канбана логиста (запросы логистам). Доступ — как у доски (layout родителя).
export const metadata = {
  title: 'Как работать с канбаном логиста — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default function Page() {
  return <GuidePage guide={GUIDE} backHref="/logist-kanban" />;
}
