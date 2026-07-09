import { redirect } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { firstNameOf, greetingForNow } from '@/lib/home/greeting';
import { HomeReportColumns } from '@/features/home/ui/HomeReportColumns';

// Главная (утверждённый макет analsteroid-home-mock.html): целевая страница
// после логина и корня «/» (см. lib/auth/perms.ts firstAllowedPath). Сессия
// уже гарантирована app/(app)/layout.tsx — redirect ниже практически
// недостижим, оставлен как защита на случай прямого рендера без layout.
export default async function HomePage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const greeting = greetingForNow();
  const firstName = firstNameOf(session.displayName);
  const canSales = hasPerm(session, 'section.sales');

  return (
    <div className="flex flex-col h-full overflow-auto bg-[var(--color-bg)]">
      <div className="flex-1 flex justify-center px-4 sm:px-8 lg:px-[60px]">
        <div className="w-full max-w-[1060px] flex flex-col items-center pt-10 sm:pt-16 lg:pt-[90px] pb-10">
          <div className="flex items-center gap-3 mb-3">
            <Sparkles size={30} className="text-[var(--color-accent)] shrink-0" aria-hidden="true" />
            <h1 className="text-[28px] sm:text-[32px] lg:text-[38px] font-semibold tracking-tight text-[#141922] text-center">
              {greeting}, {firstName}
            </h1>
          </div>
          <p className="text-base sm:text-lg text-[var(--color-text-muted)] mb-10 sm:mb-14 text-center">
            Какой отчёт будем смотреть сегодня?
          </p>
          <HomeReportColumns canSales={canSales} userLogin={session.login} />
        </div>
      </div>
    </div>
  );
}
