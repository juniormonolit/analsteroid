import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { RopDashboard } from '@/features/tv/ui/TodayDashboard';

// «РОП — сегодня» (задача #6446) — авторизованная персональная копия /today
// (решение владельца 14.09: «сделай копию как today, но /rop которая с
// авторизацией и показывает только данные согласно правам»). В отличие от
// /today (сознательно публичный, см. комментарий в app/(bare)/today/page.tsx)
// здесь: неавторизованных — на вход; авторизованных без права раздела —
// внятное «недостаточно прав» (паттерн app/(app)/screens/layout.tsx), а не
// молчаливый редирект. Данные режет ropScope() на бэкенде (/api/rop/dashboard).
export const metadata = {
  title: 'РОП — сегодня — Монолитика',
  robots: { index: false, follow: false, nocache: true },
};

export default async function Page() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.rop_today')) {
    return (
      <div className="p-6">
        <AccessDenied reason="«РОП — сегодня» — персональная копия дашборда «Сегодня по компании», урезанная по вашей зоне ответственности. Доступ выдаёт администратор в «Настройки → Роли»." />
      </div>
    );
  }
  return <RopDashboard />;
}
