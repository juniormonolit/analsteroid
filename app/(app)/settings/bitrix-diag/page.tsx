import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { BitrixDiagPage } from '@/features/b24diag/ui/BitrixDiagPage';

// Мониторинг сервера Битрикса по диагностическим логам (SFTP /logs, 16.09.2026).
export const metadata = { title: 'Логи Битрикса — Монолитика' };

export default async function Page() {
  const session = await getSession();
  if (!session?.isSuperadmin) return <AccessDenied reason="Логи сервера Битрикса доступны только супер-администратору." />;
  return <BitrixDiagPage />;
}
