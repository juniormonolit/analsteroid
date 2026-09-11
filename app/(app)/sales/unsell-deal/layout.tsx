import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { canUnsellDeal } from '@/lib/sales/unsellDeal';

// Гейт пункта меню «Ещё» (задача #6260, тот же паттерн, что у остальных
// пунктов — задача Иосифа 10.09): администратор (hasFullManagerAccess) ИЛИ
// явное право action.deals.unsell из «Настройки → Матрица прав». По умолчанию
// право не выдано ни одной роли — владелец выдаёт его ролям «Директор»+
// (РОПу — сознательно нет, требование владельца 11.09).
export default async function UnsellDealLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!canUnsellDeal(session)) {
    return (
      <AccessDenied reason="Раздел «Снять с продажи» — ручная очистка sold_at у сделки, ошибочно поставленной в продажу. Доступно директору и выше; РОП доступа не имеет. Право выдаёт администратор в «Настройки → Матрица прав»." />
    );
  }
  return <>{children}</>;
}
