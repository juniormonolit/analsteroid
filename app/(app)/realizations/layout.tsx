import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { canViewRealizations } from '@/lib/realizations/access';

// Серверный гейт «Реализация» (задача #8034): только роль
// «Администратор» (и супер-админ). Тот же canViewRealizations — в сайдбаре и API.
export default async function RealizationsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!canViewRealizations(session)) {
    return <AccessDenied reason="Раздел «Реализация» — заявки, ответы на запросы и работа логистов по данным 1С и Битрикса. Доступен только роли «Администратор»." />;
  }
  return <>{children}</>;
}
