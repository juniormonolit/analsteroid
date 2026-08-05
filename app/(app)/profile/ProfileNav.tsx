'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { IdCard, Settings, Users, UsersRound, Zap } from 'lucide-react';

// Мобильная навигация кабинета (задача 3045, §1): отдельные МАРШРУТЫ, а не
// локальный useState — ссылку на вкладку можно прислать коллеге, «назад»
// работает, состояние восстанавливается из адреса. На десктопе полосу заменяет
// левая рельса ProfileRail (layout прячет её через lg:hidden).
//
// С добавлением «Движухи» (05.08) пунктов стало пять — подписи в строку уже не
// влезали в 375px. Вместо скролла (правило 12 — это всегда компромисс) полоса
// перешла на компактные пункты «иконка сверху, подпись 10px снизу» — паттерн
// нижней навигации соцсетей; пять пунктов по ~72px укладываются в 360px.
// `min-h-11` — правило 6 (тач-цель 44px), фактическая высота пункта ~50px.
const ITEMS = [
  { href: '/profile', label: 'Кабинет', Icon: IdCard },
  { href: '/profile/team', label: 'Мой отдел', Icon: Users },
  { href: '/profile/pulse', label: 'Движуха', Icon: Zap },
  { href: '/profile/people', label: 'Коллеги', Icon: UsersRound },
  { href: '/profile/settings', label: 'Настройки', Icon: Settings },
] as const;

export function ProfileNav() {
  const pathname = usePathname();

  return (
    <nav className="shrink-0 flex items-stretch border-b border-[var(--color-border)] bg-[var(--color-bg-surface)]">
      {ITEMS.map(({ href, label, Icon }) => {
        // «Кабинет» — точное совпадение: иначе он подсвечивался бы на всех
        // вложенных адресах (/profile/team, /profile/settings) вместе с ними.
        const active = href === '/profile' ? pathname === '/profile' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`min-h-11 flex-1 flex flex-col items-center justify-center gap-0.5 py-1.5 border-b-2 -mb-px transition-colors ${
              active
                ? 'border-[var(--color-accent)] text-[var(--color-accent)] font-medium'
                : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            <Icon size={17} className="shrink-0" />
            <span className="text-[10px] leading-none whitespace-nowrap">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
