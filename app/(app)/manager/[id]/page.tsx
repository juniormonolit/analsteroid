import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { canViewManager, hasFullManagerAccess, managedDepartmentIds } from '@/lib/org/managerAccess';
import { ManagerCardPage } from '@/features/manager-card/ui/ManagerCardPage';

// ЛК менеджера: /manager/<bitrix_user_id> — карточка менеджера;
// /manager/<dept uuid|all>?mode=department — карточка отдела (агрегат).
// Начальный период можно передать через ?from&to (ISO) — так делают точки входа
// из отчётов, чтобы карточка открылась на том же периоде.
export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { id } = await params;
  const sp = await searchParams;
  const mode = sp.mode === 'department' ? 'department' as const : 'manager' as const;
  const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

  // Доступ (задача 30.07, «Вариант Б»): менеджер — только себя, РОП — свой отдел,
  // руководство — всех. Второй рубеж — в /api/manager-card/* (lib/org/managerAccess.ts).
  const allowed = mode === 'manager'
    ? await canViewManager(session, id)
    : hasFullManagerAccess(session) || id === 'my' || id === 'all'
      || (await managedDepartmentIds(session)).includes(id);
  if (!allowed) {
    return (
      <div className="p-6 text-sm text-[var(--color-text-muted)]">
        Эта карточка вам недоступна. Своя — в разделе «Мой ЛК».
      </div>
    );
  }

  return (
    <ManagerCardPage
      managerId={id}
      mode={mode}
      managerName={str(sp.name)}
      initialFrom={str(sp.from)}
      initialTo={str(sp.to)}
    />
  );
}
