'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/settings/tables', label: 'Таблицы' },
  { href: '/settings/metrics', label: 'Метрики' },
  { href: '/settings/working-calendar', label: 'Календарь' },
  { href: '/settings/users', label: 'Пользователи' },
];

export function SettingsSidebar() {
  const pathname = usePathname();

  return (
    <>
      {NAV.map(item => (
        <Link
          key={item.href}
          href={item.href}
          className={`block px-4 py-2 text-sm rounded-md mx-2 my-0.5 transition-colors ${
            pathname.startsWith(item.href)
              ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium'
              : 'text-[var(--color-text)] hover:bg-[var(--color-border)]'
          }`}
        >
          {item.label}
        </Link>
      ))}
    </>
  );
}
