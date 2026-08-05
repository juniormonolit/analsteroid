import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { PublicProfilePage } from '@/features/profile/ui/PublicProfilePage';

// Публичный профиль /profile/<bitrixId> (задача владельца 05.08, ЛК-соцсетка).
// Статические сегменты кабинета (/profile/team, /profile/people, /profile/settings)
// в Next перекрывают динамический — сюда попадают только «прочие» значения, и мы
// принимаем строго числовой Bitrix ID (иначе 404, а не попытка поиска).
// Свой id — редирект в собственный ЛК: одна сущность, никаких «я как чужой».
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  if (session.bitrixUserId === id) redirect('/profile');

  return <PublicProfilePage bitrixId={id} />;
}
