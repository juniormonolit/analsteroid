'use client';
// Полоса вкладок раздела «Большой брат». Пять вкладок — flex-wrap вместо горизонтального скролла
// (CLAUDE.md, правило 12, альтернатива для небольшого числа вкладок). «РОПы» — только тем, кому
// виден рейтинг РОПов (canViewBigBrotherRop, вычисляется в layout на сервере).
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/big-brother', label: 'Обзор', exact: true },
  { href: '/big-brother/rop', label: 'РОПы', rop: true },
  { href: '/big-brother/tasks', label: 'Задачи' },
  { href: '/big-brother/people', label: 'Люди' },
  { href: '/big-brother/watch', label: 'Сторож' },
];

export function BigBrotherTabs({ canRop }: { canRop: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Разделы «Большого брата»" className="flex min-w-0 flex-wrap gap-1">
      {TABS.filter(t => !t.rop || canRop).map(t => {
        const on = t.exact ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={on ? 'page' : undefined}
            className={`inline-flex min-h-11 items-center rounded-md px-3 text-sm ${on
              ? 'bg-[var(--color-accent)] text-white'
              : 'border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
