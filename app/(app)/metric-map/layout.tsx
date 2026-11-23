import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

// Гейт пункта «Ещё» «Карта показателей» (задача владельца 23.11) — как у остальных
// пунктов «Ещё»: администратор ИЛИ явное право роли из «Матрицы прав».
export default async function MetricMapLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.metric_map')) {
    return <AccessDenied reason="Раздел «Карта показателей» — дерево связанных показателей продаж с весами. Доступ выдаёт администратор в «Настройки → Матрица прав»." />;
  }
  return <>{children}</>;
}
