import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { TaskerPage } from '@/features/tasker/ui/shared/TaskerPage';

export const metadata = {
  title: 'Задачник — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default async function Page() {
  // Гейт раздела — в layout.tsx; здесь только право ставить задачи (кнопка «Новая задача»).
  // Сервер всё равно проверяет его в POST /api/tasker/tasks.
  const session = await getSession();
  return <TaskerPage canAssign={hasPerm(session, 'action.tasker.assign')} />;
}
