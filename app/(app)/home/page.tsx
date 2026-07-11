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
    // pt: на мобильных — небольшой фиксированный отступ (контент сразу под
    // топбаром, задача 1696 / кейс 9А аудита: 33vh съедал треть экрана
    // телефона). На md+ — прежнее центрирование на 33% высоты вьюпорта
    // («золотое сечение», бриф владельца); max()-guard не даёт заголовку
    // прилипнуть к топбару на низких/landscape-экранах. Скролл — на внешнем
    // контейнере, сама позиция заголовка не прыгает при подгрузке списков ниже.
    <div className="h-full overflow-auto bg-[var(--color-bg)]">
      <div className="flex justify-center px-4 sm:px-8 lg:px-[60px]">
        <div className="w-full max-w-[1060px] flex flex-col items-center pt-14 md:pt-[max(33vh,56px)] pb-10">
          {/* Искра стоит рядом слева от текста, но не участвует в расчёте
              центровки: она absolute внутри relative-обёртки по ширине текста,
              поэтому flex justify-center центрирует именно текст приветствия,
              а не пару «искра + текст». */}
          <div className="flex justify-center w-full mb-3">
            <div className="relative inline-flex">
              <Sparkles
                size={30}
                className="absolute right-full top-1/2 -translate-y-1/2 mr-3 text-[var(--color-accent)] shrink-0"
                aria-hidden="true"
              />
              <h1 className="text-[28px] sm:text-[32px] lg:text-[38px] font-semibold tracking-tight text-[var(--color-text)] text-center">
                {greeting}, {firstName}
              </h1>
            </div>
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
