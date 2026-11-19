import { GuidePage } from '@/features/repeat-kanban/guide/GuidePage';
import { GUIDE } from '@/features/logist-kanban/guide/content';

// Та же инструкция «Как работать?», что /logist-kanban/guide, но без гейта раздела «Канбан логиста»: менеджеры
// (у них нет section.logist_kanban) открывают её из «Запросов логистам» в ЛК.
export const metadata = {
  title: 'Как работать с запросами логистам — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default function Page() {
  return <GuidePage guide={GUIDE} backHref="/profile/logist-requests" />;
}
