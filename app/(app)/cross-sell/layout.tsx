import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

// Гейт пункта «Ещё» «Что предложить» (правка владельца 22.10: переехал из «Настроек»)
// — как у остальных пунктов «Ещё»: администратор ИЛИ явное право роли из «Матрицы прав».
export default async function CrossSellLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.cross_sell')) {
    return <AccessDenied reason="Раздел «Что предложить» — ручные приоритеты кросс-селла по товарным группам. Доступ выдаёт администратор в «Настройки → Матрица прав»." />;
  }
  return <>{children}</>;
}
