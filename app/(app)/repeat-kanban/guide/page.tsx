import { GuidePage } from '@/features/repeat-kanban/guide/GuidePage';
import { GUIDE } from '@/features/repeat-kanban/guide/content';
import { getSession } from '@/lib/auth/session';
import { hasPerm, type PermKey } from '@/lib/auth/perms';

// «Как работать?» — встроенная инструкция канбана повторных (владелец 22.10). Доступ — как у доски
// (layout родителя: право section.repeat_kanban).
export const metadata = {
  title: 'Как работать с канбаном повторных — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default async function Page() {
  // Разделы с perm (ИИ-анализ) — только у кого есть право; остальным текст не отдаём вовсе.
  const session = await getSession();
  const guide = { ...GUIDE, sections: GUIDE.sections.filter(s => !s.perm || hasPerm(session, s.perm as PermKey)) };
  return <GuidePage guide={guide} />;
}
