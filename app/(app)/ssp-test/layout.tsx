import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

// «ССП тест» — план/факт по декомпозиции года. Гейт зеркалит раздел
// «Декомпозиция» (то же право section.decomposition): данные те же, разрез другой.
export default async function SspTestLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.decomposition')) {
    return <AccessDenied reason="Раздел «ССП: план и факт» — выполнение декомпозиции года по филиалам и отделам. Доступ выдаёт администратор в «Настройки → Роли» (право «Декомпозиция»)." />;
  }
  return <>{children}</>;
}
