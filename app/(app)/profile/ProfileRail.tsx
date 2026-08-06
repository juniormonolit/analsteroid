'use client';
import Link from 'next/link';
import { useProfileNav } from './useProfileNav';

// Левая рельса ЛК «а-ля VK/Facebook» (задача владельца 05.08: «левое меню как у нас
// всегда, справа контент»). Десктоп-only (`hidden lg:flex` ставит layout): на
// телефоне её роль играет ProfileMobileNav — строка-селектор со шторкой, которая
// читает ТОТ ЖЕ список пунктов (useProfileNav), поэтому состав и порядок разделов
// на десктопе и на телефоне физически не могут разъехаться.
//
// Вкладки карточки (?tab=) и маршруты кабинета (/profile/team и т.д.) нарочно живут
// в ОДНОМ списке: для человека это один уровень навигации, как в соцсети. Сборка
// списка, порядок и группировка — в useProfileNav.ts, здесь только отрисовка.

export function ProfileRail({ mode, canManageRequests = false }: {
  mode: 'manager' | 'department' | 'none';
  /** «Заявки» — только руководителям (решает сервер в layout, чтобы не гонять
   *  лишний запрос с клиента): активации покупок и выводы MLT подчинённых. */
  canManageRequests?: boolean;
}) {
  const items = useProfileNav({ mode, canManageRequests });

  return (
    <nav className="w-56 shrink-0 flex flex-col gap-0.5 border-r border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-bg)] px-2 py-3 overflow-y-auto">
      {items.map(({ key, href, label, Icon, active, badge, group }, i) => (
        <Link
          key={key}
          // Межстрочный отступ + тонкая линия на стыке групп: разделяет
          // смысловые блоки, не добавляя в меню лишних заголовков.
          style={i > 0 && items[i - 1].group !== group ? { marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--color-sidebar-border)' } : undefined}
          href={href}
          className={`min-h-11 flex items-center gap-2.5 rounded-lg px-3 text-sm transition-colors ${
            active
              ? 'bg-[var(--color-sidebar-active-bg)] text-[var(--color-sidebar-active)] font-medium'
              : 'text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)]'
          }`}
        >
          <Icon size={18} className="shrink-0" />
          {label}
          {badge ? (
            <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-positive)] px-1 text-[10px] font-bold text-white tabular-nums">
              {badge > 99 ? '99+' : badge}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
