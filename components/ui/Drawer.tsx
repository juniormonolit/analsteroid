'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import { SLIDE_BACKDROP_BG } from './SlideBackdrop';

/**
 * Боковая панель справа (slide-over) на Radix Dialog — родня components/ui/Modal: тот же
 * focus-trap, Escape, клик по подложке, стекло. На десктопе (sm+) — панель у правого края
 * на всю высоту, ширина desktopWidth; на телефоне — на весь экран (h-dvh, с отступами под
 * вырез/home-индикатор). Въезд/выезд — те же keyframes slide-panel-*-right, что у
 * остальных правых панелей (globals.css); Radix дожидается конца анимации закрытия сам.
 * Первый потребитель — «Настройки» канбана повторных (features/repeat-kanban/ui).
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  children,
  desktopWidth = 'sm:max-w-xl',
  bodyClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  children: React.ReactNode;
  /** Ширина на десктопе, например 'sm:max-w-xl' | 'sm:max-w-[640px]' */
  desktopWidth?: string;
  bodyClassName?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={`fixed inset-0 z-50 ${SLIDE_BACKDROP_BG}`} />
        <Dialog.Content
          aria-describedby={undefined}
          className={twMerge(
            'fixed z-50 inset-y-0 right-0 flex h-dvh w-full max-w-full flex-col bg-[var(--color-bg-overlay)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] shadow-2xl outline-none',
            'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:border-l sm:border-[var(--color-border)]',
            'data-[state=open]:animate-[slide-panel-in-right_var(--anim-duration)_var(--anim-ease)_both] data-[state=closed]:animate-[slide-panel-out-right_var(--anim-duration)_var(--anim-ease)_both]',
            desktopWidth,
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
            <Dialog.Title className="min-w-0 truncate text-sm font-semibold">{title}</Dialog.Title>
            <Dialog.Close aria-label="Закрыть" className="tap-target flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]">
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className={twMerge('min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4', bodyClassName)}>{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
