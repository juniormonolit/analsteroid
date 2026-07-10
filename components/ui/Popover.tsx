'use client';
import * as RadixPopover from '@radix-ui/react-popover';
import { twMerge } from 'tailwind-merge';

/**
 * Единый адаптивный поповер (Radix Popover). Главное отличие от самописных
 * (getBoundingClientRect + position:fixed): Radix сам прижимает панель к краям
 * вьюпорта (collision detection), поэтому на узких экранах ничего не уезжает
 * за край. Все новые дропдауны/меню строить на нём (см. CLAUDE.md).
 *
 * z-index контента (задача 1575, баг «период в карточке менеджера не меняется»):
 * `RadixPopover.Portal` телепортирует контент в конец `<body>`, но сам он всё
 * равно позиционируется `fixed` и сравнивается по z-index со ВСЕМИ остальными
 * fixed-элементами страницы, а не только с ближайшим предком в дереве. Панели
 * с более высоким z, чем было раньше (`ManagerCardPanel` — `z-[60]`, `DealCard`
 * — `z-[70]`, обе выше прежнего `z-50` у этого поповера), рисуются НАД
 * поповером, даже если попап открыт «поверх» — календарь `DateRangePicker`
 * реально рендерится, просто визуально спрятан за непрозрачной панелью, клики
 * по датам ни на что не попадают. Раньше это не проявлялось, потому что ни
 * один поповер/пикер не открывался изнутри панели с z выше 50 (дрилл-даун и
 * сравнение — сами z-50, там встречный z-index совпадает и решается порядком
 * DOM, поповер уже смонтирован позже — оказывается сверху). `z-[80]` —
 * заведомо выше любой существующей fixed-панели в приложении (максимум
 * сейчас — `z-[70]` у `DealCard`), чтобы popover/datepicker были видны и
 * кликабельны из ЛЮБОЙ панели, включая будущие с ещё большим z.
 */
export function Popover({
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  /** Ширина панели: 'w-60', 'w-[280px] max-w-[calc(100vw-16px)]' и т.п. */
  className,
  open,
  onOpenChange,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          align={align}
          side={side}
          sideOffset={4}
          collisionPadding={8}
          className={twMerge(
            'z-[80] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-lg outline-none max-w-[calc(100vw-16px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto',
            className,
          )}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
