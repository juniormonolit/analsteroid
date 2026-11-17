'use client';
import { useAppMode } from '@/lib/hooks/useAppMode';
import { ProfileRail } from '../profile/ProfileRail';
import { ProfileMobileNav } from '../profile/ProfileMobileNav';
import type { ProfileNavProps } from '../profile/profileNavProps';

// Меню ЛК на канбане повторных — ТОЛЬКО внутри Битрикса (баг владельца 17.11: из ЛК в Битриксе
// перешёл в «Канбан повторных» — меню пропало, уйти можно только закрыв приложение). AppShell в iframe
// Битрикса прячет основное меню (там «только ЛК»), а у канбана своей навигации нет; адресной строки и
// «назад» у окна приложения тоже нет. Поэтому в режиме bitrix-iframe канбан (и его инструкция/аналитика)
// рисуется в той же рамке, что ЛК: рельса на ≥lg, строка-селектор со шторкой на <lg — те же компоненты
// и тот же список пунктов (useProfileNav), «Канбан повторных» в нём подсвечен активным. Так же выглядит
// и вход из пункта левого меню портала «Канбан повторных» — из него теперь тоже можно уйти в ЛК.
// В браузере/PWA ничего не меняется: там основное меню AppShell (сайдбар, шторка, нижний таб-бар) на месте,
// канбаном пользуются РОПы/админы как полноэкранной доской.
//
// Режим — только из useAppMode (правило 11 CLAUDE.md). На SSR он всегда «не iframe», поэтому меню
// появляется после гидрации; дерево при этом НЕ меняет форму (условные слоты стоят до children, обёртки
// те же), чтобы канбан не перемонтировался и не терял состояние/запросы.
export function LkNavInBitrix({ nav, children }: { nav: ProfileNavProps; children: React.ReactNode }) {
  const { isBitrixIframe } = useAppMode();
  return (
    <div className="h-full flex overflow-hidden">
      {isBitrixIframe && <div className="hidden lg:flex shrink-0"><ProfileRail {...nav} /></div>}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {isBitrixIframe && <div className="lg:hidden"><ProfileMobileNav {...nav} /></div>}
        {/* Как <main> в AppShell (flex-col + overflow-hidden): страницы канбана держат свой h-full и свой скролл. */}
        <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
