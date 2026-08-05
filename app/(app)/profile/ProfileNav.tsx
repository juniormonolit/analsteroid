'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { IdCard, Settings, Users } from 'lucide-react';

// Рельса ЛК (задача 3045, §1): три вкладки кабинета — ОТДЕЛЬНЫЕ маршруты, а не
// локальный useState, как было в старом `/profile`. Смысл требования спеки: ссылку
// на вкладку можно прислать коллеге, «назад» работает, состояние восстанавливается
// из адреса.
//
// Полоса узкая и без скролла: три пункта укладываются в 375px (правило 12 CLAUDE.md
// про горизонтальные ленты здесь не применяется — переноса и скролла не будет,
// проверено на самой длинной подписи). `min-h-11` — правило 6 (тач-цель 44px).
const ITEMS = [
  { href: '/profile', label: 'Кабинет', Icon: IdCard },
  { href: '/profile/team', label: 'Мой отдел', Icon: Users },
  { href: '/profile/settings', label: 'Настройки', Icon: Settings },
] as const;

export function ProfileNav() {
  const pathname = usePathname();

  return (
    <nav className="shrink-0 flex items-stretch gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2 sm:px-4">
      {ITEMS.map(({ href, label, Icon }) => {
        // «Кабинет» — точное совпадение: иначе он подсвечивался бы на всех
        // вложенных адресах (/profile/team, /profile/settings) вместе с ними.
        const active = href === '/profile' ? pathname === '/profile' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`min-h-11 flex items-center gap-1.5 px-3 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
              active
                ? 'border-[var(--color-accent)] text-[var(--color-accent)] font-medium'
                : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            <Icon size={15} className="shrink-0" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
