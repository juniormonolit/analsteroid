import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';

// Гейт по паттерну задачи 3045 (см. charts/layout.tsx): честное «недостаточно
// прав» на том же адресе вместо молчаливого редиректа.
export default async function PresentationLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.presentation')) {
    return <AccessDenied reason="Раздел «Презентация» — слайды еженедельного собрания по выбранным отделам. Доступ выдаёт администратор в «Настройки → Роли»." />;
  }
  return <>{children}</>;
}
