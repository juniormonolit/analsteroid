'use client';

import type { DismissalItemStatus, DismissalRunStatus, DismissalUser } from '../types';
import type { SearchSelectOption } from '@/components/ui/SearchSelect';

export const RUN_STATUS_LABELS: Record<DismissalRunStatus, string> = {
  scanning: 'Собираю',
  draft: 'Черновик',
  queued: 'В очереди',
  running: 'Выполняется',
  paused: 'На паузе',
  done: 'Готово',
  failed: 'Ошибка',
  cancelled: 'Отменён',
};

const RUN_STATUS_TONE: Record<DismissalRunStatus, string> = {
  scanning: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
  draft: 'bg-[var(--color-bg-hover)] text-[var(--color-text)]',
  queued: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
  running: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
  paused: 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]',
  done: 'bg-[var(--color-positive)]/15 text-[var(--color-positive)]',
  failed: 'bg-[var(--color-negative)]/15 text-[var(--color-negative)]',
  cancelled: 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]',
};

export function RunStatusBadge({ status }: { status: DismissalRunStatus }) {
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${RUN_STATUS_TONE[status]}`}>
      {RUN_STATUS_LABELS[status]}
    </span>
  );
}

export const ITEM_STATUS_LABELS: Record<DismissalItemStatus, string> = {
  pending: 'Ждёт',
  done: 'Сделано',
  skipped: 'Пропущено',
  error: 'Ошибка',
};

const ITEM_STATUS_TONE: Record<DismissalItemStatus, string> = {
  pending: 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]',
  done: 'bg-[var(--color-positive)]/15 text-[var(--color-positive)]',
  skipped: 'bg-[var(--color-bg-hover)] text-[var(--color-text)]',
  error: 'bg-[var(--color-negative)]/15 text-[var(--color-negative)]',
};

export function ItemStatusBadge({ status }: { status: DismissalItemStatus }) {
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${ITEM_STATUS_TONE[status]}`}>
      {ITEM_STATUS_LABELS[status]}
    </span>
  );
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border border-[var(--color-negative)]/40 bg-[var(--color-negative)]/10 px-3 py-2 text-sm text-[var(--color-text)] break-words">
      {children}
    </div>
  );
}

export function userHint(u: Pick<DismissalUser, 'position' | 'department'>): string | null {
  return [u.position, u.department].filter(Boolean).join(' · ') || null;
}

/** Опции получателей: только действующие сотрудники, кроме самого уволенного. */
export function recipientOptions(users: DismissalUser[] | undefined, sourceBitrixId: number): SearchSelectOption[] {
  return (users ?? [])
    .filter(u => u.active && u.bitrixId !== sourceBitrixId)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    .map(u => ({ value: String(u.bitrixId), label: u.name, hint: userHint(u) }));
}

export const btnPrimary = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:hover:bg-[var(--color-accent)]';
export const btnSecondary = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50';
export const btnDanger = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-negative)]/50 px-3 text-sm text-[var(--color-negative)] hover:bg-[var(--color-negative)]/10 disabled:opacity-50';
export const card = 'rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]';
