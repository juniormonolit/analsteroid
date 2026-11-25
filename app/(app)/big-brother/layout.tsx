import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { canViewBigBrother, canViewBigBrotherRop } from '@/lib/activity/access';
import { BigBrotherTabs } from '@/components/activity/BigBrotherTabs';

// «Большой брат» (BIG_BROTHER_SPEC.md): журнал активности и «активность ↔ показатели».
// Гейт раздела — директор и выше (superadmin / Администратор / роль Директор) или явное section.big_brother.
// Каркас: шапка + вкладки сверху, ниже — прокручиваемая область страницы вкладки (page-root со
// overflow-x-hidden, правило 13). Страницам вкладок своя h-full-обёртка не обязательна.
// Вкладку «РОПы» её страница гейтит сама (canViewBigBrotherRop) — здесь лишь прячется из полосы.
export default async function BigBrotherLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!canViewBigBrother(session)) {
    return <AccessDenied reason="«Большой брат» — журнал активности сотрудников. Раздел открыт директорам и администраторам; остальным доступ выдаёт администратор в «Настройки → Матрица прав»." />;
  }
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-6 sm:py-6">
        <header className="flex min-w-0 flex-col gap-2">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Большой брат</h1>
          <BigBrotherTabs canRop={canViewBigBrotherRop(session)} />
        </header>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
