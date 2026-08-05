import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { landingFor } from '@/lib/auth/perms';

// Корень: единственная точка, где решается стартовый адрес (задача 3045, §5).
// Сюда же ведут страница логина и приём инвайта — им не нужно дублировать правило,
// достаточно отправить человека на «/».
export default async function Root() {
  const session = await getSession();
  redirect(landingFor(session));
}
