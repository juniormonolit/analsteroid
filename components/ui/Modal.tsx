'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { twMerge } from 'tailwind-merge';

/**
 * Единый адаптивный модал (Radix Dialog): на десктопе — центрированное окно,
 * на телефоне — bottom-sheet на всю ширину. Focus-trap, Escape и клик по
 * подложке — из коробки. Все новые модалки строить на нём, не руками через
 * fixed inset-0 (см. CLAUDE.md, раздел «Адаптивность»).
 */
export function Modal({
  open,
  onOpenChange,
  title,
  children,
  /** Ширина на десктопе, например 'sm:max-w-md' | 'sm:max-w-[460px]' */
  desktopWidth = 'sm:max-w-md',
  contentClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  desktopWidth?: string;
  contentClassName?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className={twMerge(
            // мобильный: bottom-sheet во всю ширину, с отступом под home-индикатор
            'fixed z-50 inset-x-0 bottom-0 w-full max-h-[85dvh] overflow-y-auto rounded-t-xl bg-[var(--color-bg-surface)] shadow-xl outline-none pb-[env(safe-area-inset-bottom)]',
            // десктоп (sm+): центрированное окно
            'sm:inset-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:max-h-[85vh] sm:pb-0',
            desktopWidth,
            contentClassName,
          )}
        >
          {title !== undefined && (
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] sticky top-0 bg-[var(--color-bg-surface)] rounded-t-xl sm:rounded-t-lg">
              <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
              <Dialog.Close className="tap-target p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
                <X size={16} />
              </Dialog.Close>
            </div>
          )}
          <div className="p-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
