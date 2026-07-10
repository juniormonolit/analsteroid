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
  canViewSettings,
  canManageUsers,
  isSuperadmin,
}: {
  // section.settings — «Настройки» в узком смысле (Таблицы/Метрики/Цвета/Календарь).
  // Права v2: раздел /settings стал доступен и без него (см. layout.tsx) — тем, у
  // кого есть только action.users.manage, чтобы не терять «Пользователи».
  canViewSettings: boolean;
  canManageUsers: boolean;
  isSuperadmin: boolean;
}) {
  const pathname = usePathname();

  const items = [
    ...(canViewSettings ? NAV : []),
    ...(canManageUsers ? [{ href: '/settings/users', label: 'Пользователи' }] : []),
    ...(isSuperadmin ? [{ href: '/settings/roles', label: 'Роли' }] : []),
    ...(isSuperadmin ? [{ href: '/settings/rights-matrix', label: 'Матрица прав' }] : []),
    ...(isSuperadmin ? [{ href: '/settings/daily-plan-mode', label: 'Режим дневного плана' }] : []),
    ...(isSuperadmin ? [{ href: '/settings/scoring-weights', label: 'Веса скоринга' }] : []),
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
