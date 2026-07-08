'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/settings/tables', label: 'Таблицы' },
  { href: '/settings/metrics', label: 'Метрики' },
  { href: '/settings/metric-colors', label: 'Цвета метрик' },
  { href: '/settings/working-calendar', label: 'Календарь' },
];

export function SettingsSidebar({
  canManageUsers,
  isSuperadmin,
}: {
  canManageUsers: boolean;
  isSuperadmin: boolean;
}) {
  const pathname = usePathname();

  const items = [
    ...NAV,
    ...(canManageUsers ? [{ href: '/settings/users', label: 'Пользователи' }] : []),
    ...(isSuperadmin ? [{ href: '/settings/roles', label: 'Роли' }] : []),
  ];

  return (
    <>
      {items.map(item => (
        <Link
          key={item.href}
          href={item.href}
          className={`block whitespace-nowrap shrink-0 px-3 md:px-4 py-2 text-sm rounded-md mx-1 md:mx-2 my-0.5 transition-colors ${
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
