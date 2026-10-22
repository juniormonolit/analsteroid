import { GuidePage } from '@/features/repeat-kanban/guide/GuidePage';
import { GUIDE } from '@/features/repeat-kanban/guide/content';

// «Как работать?» — встроенная инструкция канбана повторных (владелец 22.10). Доступ — как у доски
// (layout родителя: право section.repeat_kanban).
export const metadata = {
  title: 'Как работать с канбаном повторных — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default function Page() {
  return <GuidePage guide={GUIDE} />;
}
