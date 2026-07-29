import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

// «Повторные» (#1725, задача владельца 27.07) — ТОЛЬКО супер-админ, как
// /settings/roles и /settings/rights-matrix. Раздел раньше был скрыт от всех;
// возвращается в меню, но с более узким доступом, чем остальные разделы
// «Продажи» (section.sales здесь не проверяем — этого мало, нужен именно
// isSuperadmin). Дублирует проверку в app/api/reports/repeat/route.ts —
// серверная сторона не должна полагаться только на скрытый пункт меню.
export default async function RepeatLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isSuperadmin) redirect('/sales');
  return <>{children}</>;
}
