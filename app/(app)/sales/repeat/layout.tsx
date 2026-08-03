import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';

// «Повторные» (#1725, задача владельца 27.07) — ТОЛЬКО супер-админ, как
// /settings/roles и /settings/rights-matrix. Раздел раньше был скрыт от всех;
// возвращается в меню, но с более узким доступом, чем остальные разделы
// «Продажи» (section.sales здесь не проверяем — этого мало, нужен именно
// isSuperadmin). Дублирует проверку в app/api/reports/repeat/route.ts —
// серверная сторона не должна полагаться только на скрытый пункт меню.
//
// Задача 2824 (баг из аудита): было `redirect('/sales')` — а `app/(app)/sales/`
// не имеет собственного `page.tsx` (только `layout.tsx` + дочерние роуты), поэтому
// редирект вёл на обычный Next.js 404 вместо «недостаточно прав». Заменено на
// AccessDenied напрямую — без промежуточного редиректа на несуществующий путь.
export default async function RepeatLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isSuperadmin) {
    return <AccessDenied reason="Раздел «Повторные продажи» — только для супер-администратора." />;
  }
  return <>{children}</>;
}
