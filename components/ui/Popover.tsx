'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { twMerge } from 'tailwind-merge';
import { Tooltip } from '@/components/ui/Tooltip';

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
 *
 * Прокрутка внутри модалки (баг 18.11, «Перенести в…» в карточке канбана больших чеков:
 * список не крутится ни колесом, ни тачем). Radix Dialog (Modal/Drawer) вешает scroll-lock
 * react-remove-scroll: wheel/touchmove на document отменяются для всего, что вне контента
 * диалога. Панель поповера порталится в `<body>` — то есть «вне», и её список не
 * прокручивается. Лечение: если триггер стоит внутри `[role="dialog"]`, поповер
 * открывается в `modal`-режиме — Radix оборачивает панель в СВОЙ RemoveScroll, он
 * становится верхним в стеке блокировок (активен только верхний), и прокрутка панели
 * разрешена. Побочно (как у нативного select): клик мимо панели только закрывает её.
 * Вне диалогов поведение прежнее (не modal). Явно переопределить — проп `modal`.
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
  tooltip,
  sideOffset = 4,
  modal,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Подсказка на триггере (рельса свёрнутого сайдбара). Нужна `open` (controlled):
      пока панель открыта, подсказка не рисуется. Tooltip стоит СНАРУЖИ Trigger —
      компонент Tooltip props на ребёнка не пробрасывает, обратный порядок не работает. */
  tooltip?: string;
  sideOffset?: number;
  /** По умолчанию — авто: true, если триггер внутри Radix Dialog (см. «Прокрутка внутри модалки»). */
  modal?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [inDialog, setInDialog] = useState(false);
  // Решаем до первого открытия: modal нужен уже при монтировании Content.
  useLayoutEffect(() => {
    setInDialog(!!triggerRef.current?.closest('[role="dialog"],[role="alertdialog"]'));
  }, []);
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange} modal={modal ?? inDialog}>
      <Tooltip content={tooltip} side="right" disabled={!tooltip || !!open}>
        <RadixPopover.Trigger asChild ref={triggerRef}>{trigger}</RadixPopover.Trigger>
      </Tooltip>
      <RadixPopover.Portal>
        <RadixPopover.Content
          align={align}
          side={side}
          sideOffset={sideOffset}
          collisionPadding={8}
          className={twMerge(
            // Регресс #2999 (04.08): та же дыра, что и у Modal.tsx — --color-bg-surface
            // без backdrop-filter просвечивал контент страницы под дропдауном/датапикером.
            // Тот же фикс: плотный --color-bg-overlay + реальный блюр (Tailwind arbitrary
            // property, не хендрайтен CSS — см. комментарий в Modal.tsx).
            'z-[80] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-overlay)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] shadow-lg outline-none max-w-[calc(100vw-16px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto',
            className,
          )}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
