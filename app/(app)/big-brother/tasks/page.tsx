import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { canViewTaskDiscipline } from '@/features/big-brother/engine/rop/access';
import { TaskDisciplinePage } from '@/features/big-brother/ui/tasks/TaskDisciplinePage';

// «Большой брат» → «Задачи». Гейт продублирован здесь и в API (не зависит от layout раздела); срез — в API.
export default async function BigBrotherTasksRoute() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!canViewTaskDiscipline(session)) return <AccessDenied reason="Раздел «Большой брат» — для уровня «директор и выше»." />;
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <TaskDisciplinePage />
    </div>
  );
}
