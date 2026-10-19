import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

// Гейт пункта «Ещё» «Вход и хвост» (задача владельца 19.10) — как у остальных
// пунктов «Ещё»: администратор ИЛИ явное право роли из «Матрицы прав».
export default async function ClientTailLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.client_tail')) {
    return <AccessDenied reason="Раздел «Вход и хвост» — выручка клиентов после выбранных сделок. Доступ выдаёт администратор в «Настройки → Матрица прав»." />;
  }
  return <>{children}</>;
}
