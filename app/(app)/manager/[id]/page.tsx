import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
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
