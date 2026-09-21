import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

// Гейт пункта «Ещё» — тот же паттерн, что у «Данных по годам»: администратор
// ИЛИ явное право роли из «Настройки → Матрица прав». Внутри раздела данные
// дополнительно режутся срезом сессии (см. /api/map/points).
export default async function MapLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.map')) {
    return <AccessDenied reason="Раздел «Карта объектов» — адреса доставки на карте. Доступ выдаёт администратор в «Настройки → Матрица прав»." />;
  }
  return <>{children}</>;
}
