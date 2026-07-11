'use client';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { twMerge } from 'tailwind-merge';

/**
 * Единый тултип (Radix Tooltip) — тот же принцип, что у components/ui/Popover:
 * контент телепортируется в конец <body> и позиционируется через Floating UI
 * (collision detection к краям вьюпорта), поэтому не зависит от overflow
 * родителей. Нужно именно это, а не самописный getBoundingClientRect + fixed
 * (запрещено правилом 4 CLAUDE.md/scripts/check-responsive.mjs) — например,
 * рельса сайдбара (задача 1688) лежит внутри скроллируемого <nav
 * overflow-y-auto>, который иначе обрезал бы тултип, торчащий за пределы
 * 52px рельсы (CSS: overflow-y != visible вынуждает overflow-x стать auto).
 *
 * TooltipProvider оборачивает дерево один раз (см. AppShell) — общий
 * delayDuration/skipDelayDuration для всех тултипов приложения.
 */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={200} skipDelayDuration={300}>
      {children}
    </RadixTooltip.Provider>
  );
}

export function Tooltip({
  content,
  children,
  side = 'right',
  disabled,
  className,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Тултип не рендерится вовсе (не только скрыт) — напр. в развёрнутом сайдбаре. */
  disabled?: boolean;
  className?: string;
}) {
  if (disabled) return <>{children}</>;
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={8}
          collisionPadding={8}
          className={twMerge(
            'z-[80] select-none rounded-md bg-[var(--color-tooltip-bg)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-tooltip-text)] shadow-lg',
            className,
          )}
        >
          {content}
          <RadixTooltip.Arrow className="fill-[var(--color-tooltip-bg)]" width={10} height={5} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
