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
  bodyClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  desktopWidth?: string;
  contentClassName?: string;
  /**
   * Классы тела модала (обёртка children, по умолчанию только p-4). Нужен, когда
   * прокрутку надо перенести с Dialog.Content на тело: у Content стоят transform
   * (десктоп) и backdrop-filter — оба делают его containing block для
   * position:fixed потомков, и fixed-панель внутри скроллящегося Content уезжала
   * вместе с содержимым (см. MetricBreakdownModal: карточка сделки в разборе).
   */
  bodyClassName?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className={twMerge(
            // мобильный: bottom-sheet во всю ширину, с отступом под home-индикатор
            // Регресс #2999 (04.08): страница под модалкой просвечивала насквозь —
            // --color-bg-surface (68%/60%/7.5% альфы по темам) без backdrop-filter
            // давало полупрозрачную дыру, не стекло. Настоящий блюр — доказанно рабочий
            // приём (см. AppShell.tsx/BottomTabBar.tsx, [backdrop-filter:var(--glass-blur)]
            // как Tailwind-нативный arbitrary-property класс — компилируется движком
            // Tailwind самим, а не хендрайтен-правилом в globals.css, поэтому не
            // вытесняется, в отличие от ручного .bg-\[var\(...\)\]{} — см. WORKLOG) +
            // заведомо плотный --color-bg-overlay (94-96% альфы, отдельный от
            // --color-bg-surface токен, см. globals.css) — вместе гарантируют, что текста
            // страницы за модалкой не видно ни в одной теме.
            'fixed z-50 inset-x-0 bottom-0 w-full max-h-[85dvh] overflow-y-auto rounded-t-xl bg-[var(--color-bg-overlay)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] shadow-xl outline-none pb-[env(safe-area-inset-bottom)]',
            // десктоп (sm+): центрированное окно
            'sm:inset-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:max-h-[85vh] sm:pb-0',
            desktopWidth,
            contentClassName,
          )}
        >
          {title !== undefined && (
            // Стекло-в-стекле (аудит #2999): раньше шапка и внешний лист сидели на ОДНОМ
            // токене --color-bg-surface — два самостоятельных полупрозрачных слоя без
            // общего backdrop-filter. Теперь у шапки СВОЙ backdrop-filter не нужен: она
            // лежит поверх уже заблюренного+уплотнённого тела модалки (bg-[var(--color-bg-overlay)]
            // выше), а не поверх страницы — повторный blur тут ничего не даёт, только
            // расходует GPU и рискует артефактами вложенного backdrop-filter в Safari.
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] sticky top-0 bg-[var(--color-bg-overlay)] rounded-t-xl sm:rounded-t-lg">
              {/* min-w-0: без него h2 как flex-item держит min-content ширину всего
                  nowrap-заголовка — truncate внутри не срабатывает, а крестик на 375px
                  уезжает за край и тело модала скроллится вбок. */}
              <Dialog.Title className="text-sm font-semibold min-w-0">{title}</Dialog.Title>
              <Dialog.Close className="tap-target p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
                <X size={16} />
              </Dialog.Close>
            </div>
          )}
          <div className={twMerge('p-4', bodyClassName)}>{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
