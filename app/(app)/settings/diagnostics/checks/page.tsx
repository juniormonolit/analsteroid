import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { DiagChecksPage } from '@/features/diag/ui/DiagChecksPage';

// Движок диагностики «Аналитик», фаза 0 (ТЗ №1 §12): проверки данных перед кодом.
export const metadata = { title: 'Диагностика · проверки данных — Монолитика' };

export default async function Page() {
  const session = await getSession();
  if (!session?.isSuperadmin) return <AccessDenied reason="Проверки движка диагностики доступны только супер-администратору." />;
  return <DiagChecksPage />;
}
