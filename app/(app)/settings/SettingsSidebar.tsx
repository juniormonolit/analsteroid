'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Группировка навигации «Настройки» (бриф 09.07, п.1): страниц стало много (Права v2 +
// карточка менеджера v2 добавили Роли/Матрицу прав/Веса скоринга/Режим дневного плана
// поверх исходных Таблиц/Метрик/Цветов/Календаря) — один плоский список стал нечитаемым.
// Три смысловые группы, каждая рендерится, только если в ней есть хотя бы один
// доступный пункт (иначе висит пустой заголовок).
interface NavGroup {
  label: string;
  items: { href: string; label: string; visible: boolean }[];
}

export function SettingsSidebar({
  canViewSettings,
  canManageUsers,
  isSuperadmin,
}: {
  // section.settings — «Справочники» в узком смысле (Таблицы/Метрики/Цвета/Календарь).
  // Права v2: раздел /settings стал доступен и без него (см. layout.tsx) — тем, у
  // кого есть только action.users.manage, чтобы не терять «Пользователи».
  canViewSettings: boolean;
  canManageUsers: boolean;
  isSuperadmin: boolean;
}) {
  const pathname = usePathname();

  const groups: NavGroup[] = [
    {
      label: 'Пользователи и права',
      items: [
        { href: '/settings/users', label: 'Пользователи', visible: canManageUsers },
        { href: '/settings/roles', label: 'Роли', visible: isSuperadmin },
        { href: '/settings/rights-matrix', label: 'Матрица прав', visible: isSuperadmin },
      ],
    },
    {
      label: 'Расчёты',
      items: [
        { href: '/settings/scoring-weights', label: 'Веса скоринга', visible: isSuperadmin },
        { href: '/settings/daily-plan-mode', label: 'Режим дневного плана', visible: isSuperadmin },
      ],
    },
    {
      label: 'Справочники',
      items: [
        { href: '/settings/tables', label: 'Таблицы', visible: canViewSettings },
        { href: '/settings/metrics', label: 'Метрики', visible: canViewSettings },
        { href: '/settings/metric-colors', label: 'Цвета метрик', visible: canViewSettings },
        { href: '/settings/working-calendar', label: 'Календарь', visible: canViewSettings },
      ],
    },
  ]
    .map(g => ({ ...g, items: g.items.filter(i => i.visible) }))
    .filter(g => g.items.length > 0);

  return (
    <>
      {groups.map((g, gi) => (
        // На телефоне (горизонтальные табы) группы идут ПОДРЯД в одном ряду —
        // разделитель слева (border-l); на md+ (вертикальный сайдбар) — сверху
        // (border-t) с отступом, заголовок группы виден только на md+.
        <div
          key={g.label}
          className={gi > 0 ? 'ml-1 pl-1 border-l border-[var(--color-border)] md:ml-0 md:pl-0 md:mt-3 md:pt-2 md:border-l-0 md:border-t' : ''}
        >
          <div className="hidden md:block px-4 pt-1 pb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
            {g.label}
          </div>
          <div className="flex md:flex-col">
            {g.items.map(item => (
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
          </div>
        </div>
      ))}
    </>
  );
}
