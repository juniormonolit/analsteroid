import { notFound } from 'next/navigation';
import { TakeTestPage } from '@/features/tasker/tests/ui/TakeTestPage';

// Прохождение теста (id = назначение). Ссылка приходит менеджеру от бота «Аналитик»; чужое назначение API не отдаст.
export const metadata = {
  title: 'Тест — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return <TakeTestPage id={id} />;
}
