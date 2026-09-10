import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { DiagnosticsPage } from '@/features/diag/ui/DiagnosticsPage';

// Экран диагностики (ТЗ №1 §11). Фаза 1: пока только супер-админ; право
// section.diagnostics + срез по филиалу для РОПа — следующий шаг.
export const metadata = { title: 'Диагностика — Монолитика' };

export default async function Page() {
  const session = await getSession();
  if (!session?.isSuperadmin) return <AccessDenied reason="Диагностика пока доступна только супер-администратору." />;
  return <DiagnosticsPage />;
}
