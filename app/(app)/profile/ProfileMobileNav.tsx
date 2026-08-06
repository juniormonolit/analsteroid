'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ChevronDown, LayoutGrid } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { useProfileNav, activeProfileNavItem } from './useProfileNav';

// Мобильная навигация ЛК: ОДНА строка-селектор «где я сейчас» + шторка со всеми
// разделами (задача «три уровня меню одновременно», решение владельца 06.08.2026
// после сравнения трёх вариантов компоновки).
//
// Что было до этого на 375px одновременно: полоса приложения снизу, полоса
// кабинета ProfileNav (7 пунктов, подписи резались до «Увед.»), лента вкладок
// карточки ManagerTabBar (обрезана на «С…») — ~205px вертикали до контента и два
// НЕПОЛНЫХ списка разделов вместо одного (владелец: «каша сверху»). Теперь строка
// одна (~48px), а полный список живёт в шторке, где влезает целиком и с
// группировкой — той же, что в десктопной рельсе (общий useProfileNav).
//
// Почему шторка, а не одна горизонтальная лента со всеми 17 пунктами: лента
// упирается ровно в болячку задачи 2779 — обрезанный край, поиск свайпом,
// «Инвентарь» за краем экрана. Шторка показывает все разделы сразу и убирает
// горизонтальный скролл из навигации совсем, ценой второго тапа при переходе
// между соседними разделами.
//
// Показ управляется брейкпоинтом в layout (`lg:hidden`), а не useAppMode —
// правило 8 CLAUDE.md (сначала CSS): «мобильный браузер» и «PWA на телефоне»
// здесь неразличимы и не должны различаться, оба узкие; PWA на широком десктопе
// должно вести себя как десктоп — и это то же условие «узкий вьюпорт».
export function ProfileMobileNav({ mode, canManageRequests = false }: {
  mode: 'manager' | 'department' | 'none';
  canManageRequests?: boolean;
}) {
  const items = useProfileNav({ mode, canManageRequests });
  const current = activeProfileNavItem(items);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Переход закрывает шторку. Клик по ссылке закрывает её сам (onClick ниже), но
  // навигация бывает и мимо: «назад» браузера/жест в PWA, переход из контента
  // страницы. Клиентский роутинг Next не размонтирует этот компонент, поэтому без
  // эффекта шторка осталась бы открытой поверх уже другого раздела.
  useEffect(() => { setOpen(false); }, [pathname, searchParams]);

  const CurrentIcon = current?.Icon ?? LayoutGrid;
  const unread = items.find(it => it.key === 'notifications')?.badge ?? 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="min-h-12 w-full shrink-0 flex items-center gap-2.5 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 text-left"
      >
        <CurrentIcon size={18} className="shrink-0 text-[var(--color-accent)]" />
        {/* min-w-0 + truncate: длинные названия разделов («Колесо фортуны»,
            «Мои заказчики») не должны распирать строку по горизонтали. */}
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--color-text)]">
          {current?.label ?? 'Кабинет'}
        </span>
        {/* Непрочитанное видно, не открывая шторку — иначе единственный индикатор
            уведомлений пропал бы вместе со старой полосой. Пункт «Уведомления»
            свой счётчик показывает и внутри шторки. */}
        {unread > 0 && !current?.badge && (
          <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-positive)] px-1 text-[10px] font-bold text-white tabular-nums">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Разделы</span>
        <ChevronDown size={16} className="shrink-0 text-[var(--color-text-muted)]" />
      </button>

      <Modal open={open} onOpenChange={setOpen} title="Разделы кабинета" desktopWidth="sm:max-w-sm">
        <nav className="flex flex-col gap-0.5">
          {items.map(({ key, href, label, Icon, active, badge, group }, i) => (
            <Link
              key={key}
              href={href}
              onClick={() => setOpen(false)}
              // Разделители групп — те же, что в десктопной рельсе: смысловые
              // блоки отделены линией, без лишних заголовков.
              style={i > 0 && items[i - 1].group !== group
                ? { marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--color-border)' }
                : undefined}
              className={`min-h-11 flex items-center gap-3 rounded-lg px-3 text-[15px] ${
                active
                  ? 'bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent)]'
                  : 'text-[var(--color-text)]'
              }`}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={18} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {badge ? (
                <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-positive)] px-1 text-[10px] font-bold text-white tabular-nums">
                  {badge > 99 ? '99+' : badge}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>
      </Modal>
    </>
  );
}
