import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { MeetingsPage } from '@/features/tasker/meetings/ui/MeetingsPage';

export const metadata = {
  title: 'Собрания — Задачник — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

// Гейт раздела — в layout.tsx Задачника; здесь только право создавать (РОП/директор/админ).
// Сервер проверяет его сам в POST/PATCH/DELETE /api/tasker/meetings.
export default async function Page() {
  const session = await getSession();
  return <MeetingsPage canAssign={hasPerm(session, 'action.tasker.assign')} />;
}
