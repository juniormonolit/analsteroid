import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';

// Гейт пункта «Ещё» «Источники» (задача владельца 22.10) — как у остальных пунктов
// «Ещё»: администратор ИЛИ явное право роли из «Матрицы прав».
export default async function MarketingSourcesLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.marketing_sources')) {
    return <AccessDenied reason="Раздел «Источники» — структура маркетинговых источников для отчётов «Маркетинга». Доступ выдаёт администратор в «Настройки → Матрица прав»." />;
  }
  return <>{children}</>;
}
