import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { AccessDenied } from '@/components/ui/AccessDenied';

// «Повторные» (#1725, задача владельца 27.07) — исторически ТОЛЬКО супер-админ.
// Задача Иосифа 10.09 (пункты «Ещё» — через матрицу прав): супер-админ (байпас
// внутри hasPerm) ИЛИ право section.repeat из «Настройки → Матрица прав»
// (джокер «Все разделы» покрывает и его, как любой section.*). Зеркальный гейт
// стоит в app/api/reports/repeat/route.ts — скрытый пункт меню сам по себе не
// защита. AccessDenied вместо редиректа — /sales без page.tsx давал 404 (2824).
export default async function RepeatLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasPerm(session, 'section.repeat')) {
    return <AccessDenied reason="Раздел «Повторные продажи». Доступ выдаёт администратор в «Настройки → Матрица прав»." />;
  }
  return <>{children}</>;
}
