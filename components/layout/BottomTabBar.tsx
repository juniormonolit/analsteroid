'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, User, Trophy, MoreHorizontal } from 'lucide-react';

/**
 * Нижняя навигация — мобиль/узкий standalone вместо гамбургера в шапке
 * (задача 2764, «ЛК как мобильное приложение»). Рендерится в AppShell как
 * обычный flex-сиблинг `<main>` (не `position: fixed` — оверлей потребовал бы
 * доп. bottom-padding в КАЖДОЙ из ~30 страниц, у которых свой внутренний
 * скролл-контейнер `h-full overflow-y-auto`; так `<main>` просто получает
 * меньше высоты, и всем страницам ничего менять не нужно).
 *
 * Показ управляется ЧИСТЫМ CSS-брейкпоинтом (`md:hidden`), не `useAppMode` —
 * осознанно: правило 8 CLAUDE.md — сначала пробовать CSS, хук только когда
 * признак недоступен CSS в принципе. «Мобильный браузер» и «standalone на
 * телефоне» тут неразличимы и не должны различаться — оба узкие, оба должны
 * показывать нижний таб-бар; «standalone на широком десктопе» должен вести
 * себя как десктоп (сайдбар, не таб-бар) — а это ровно то же самое условие
 * «узкий вьюпорт», что и для обычного мобильного браузера. Один брейкпоинт
 * закрывает все случаи из ТЗ без JS-ветвления.
 *
 * Набор из 4 пунктов — первый черновой срез (Главная/Мой кабинет/Рейтинг —
 * всегда видны без прав; «Ещё» открывает ПОЛНЫЙ существующий off-canvas
 * drawer с остальными разделами, ничего не теряется). Владелец может
 * попросить другой состав — это единственный массив ниже, менять точечно,
 * не архитектуру.
 */
const TABS: { href: string; label: string; icon: React.ReactNode; match: (p: string) => boolean }[] = [
  { href: '/home', label: 'Главная', icon: <Home size={20} />, match: (p) => p === '/home' },
  { href: '/manager/me', label: 'Мой кабинет', icon: <User size={20} />, match: (p) => p.startsWith('/manager') },
  { href: '/rating', label: 'Рейтинг', icon: <Trophy size={20} />, match: (p) => p.startsWith('/rating') },
];

export function BottomTabBar({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();

  return (
    <nav
      className="md:hidden shrink-0 flex items-stretch border-t border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-bg)] pb-[env(safe-area-inset-bottom)]"
      aria-label="Основная навигация"
    >
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`tap-target flex-1 flex flex-col items-center justify-center gap-0.5 min-h-11 py-1.5 text-[11px] font-semibold transition-colors ${
              active ? 'text-[var(--color-sidebar-active)]' : 'text-[var(--color-sidebar-text-muted)]'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            {tab.icon}
            <span className="truncate max-w-full px-1">{tab.label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMore}
        className="tap-target flex-1 flex flex-col items-center justify-center gap-0.5 min-h-11 py-1.5 text-[11px] font-semibold text-[var(--color-sidebar-text-muted)] transition-colors"
      >
        <MoreHorizontal size={20} />
        <span className="truncate max-w-full px-1">Ещё</span>
      </button>
    </nav>
  );
}
