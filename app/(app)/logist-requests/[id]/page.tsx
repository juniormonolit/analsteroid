import { notFound } from 'next/navigation';
import { LogistRequestFormPage } from '@/features/logist-kanban/form/LogistRequestFormPage';

// Ссылка бота «Аналитик» «дополнить запрос» (S2, robot → /api/logist-requests/trigger): форма запроса логисту.
// Без гейта раздела: менеджер открывает СВОЙ запрос (видимость режет API, у роли продаж нет section.logist_kanban).
export const metadata = {
  title: 'Запрос логисту — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,12}$/.test(id)) notFound();
  return <LogistRequestFormPage requestId={Number(id)} />;
}
