'use client';
import * as RadixPopover from '@radix-ui/react-popover';
import { twMerge } from 'tailwind-merge';

/**
 * Единый адаптивный поповер (Radix Popover). Главное отличие от самописных
 * (getBoundingClientRect + position:fixed): Radix сам прижимает панель к краям
 * вьюпорта (collision detection), поэтому на узких экранах ничего не уезжает
 * за край. Все новые дропдауны/меню строить на нём (см. CLAUDE.md).
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
            'z-50 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-lg outline-none max-w-[calc(100vw-16px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto',
            className,
          )}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
