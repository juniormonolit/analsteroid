import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

// Гейт по паттерну задачи 3045 (см. charts/layout.tsx): честное «недостаточно
// прав» на том же адресе вместо молчаливого редиректа.
export default async function PresentationLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  // Гейт пункта меню «Ещё» (задача Иосифа 10.09): администратор (аудит 09.09)
  // ИЛИ явное право роли из «Настройки → Матрица прав».
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.presentation')) {
    return <AccessDenied reason="Раздел «Презентация» — слайды еженедельного собрания по выбранным отделам. Доступ выдаёт администратор в «Настройки → Роли»." />;
  }
  return <>{children}</>;
}
