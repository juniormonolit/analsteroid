'use client';

import { AlertTriangle } from 'lucide-react';
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

/** Статус прогона; «Готово» с ошибками строк/завершающих шагов — warning: «Готово, ошибок: N». */
export function RunStatusBadge({ status, errors = 0 }: { status: DismissalRunStatus; errors?: number }) {
  const warn = status === 'done' && errors > 0;
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${warn ? 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]' : RUN_STATUS_TONE[status]}`}>
      {warn ? `Готово, ошибок: ${errors.toLocaleString('ru-RU')}` : RUN_STATUS_LABELS[status]}
    </span>
  );
}

/** Ошибки прогона для бейджа: строки + завершающие шаги (если есть в detail). */
export function runErrors(run: { counts: { error: number }; finals?: { ropMessage: { status: string }; passwordReset: { status: string } } | null }): number {
  return run.counts.error + (run.finals ? Number(run.finals.ropMessage.status === 'error') + Number(run.finals.passwordReset.status === 'error') : 0);
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

/** Статус строки; при отменённом прогоне ожидающие — «Не выполнено». */
export function ItemStatusBadge({ status, cancelled }: { status: DismissalItemStatus; cancelled?: boolean }) {
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${ITEM_STATUS_TONE[status]}`}>
      {cancelled && status === 'pending' ? 'Не выполнено' : ITEM_STATUS_LABELS[status]}
    </span>
  );
}

export function ErrorBox({ children, onRetry, retryLabel = 'Повторить' }: { children: React.ReactNode; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--color-negative)]/40 bg-[var(--color-negative)]/10 px-3 py-2 text-sm text-[var(--color-text)]">
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="min-h-11 shrink-0 font-medium text-[var(--color-accent)] hover:underline">{retryLabel}</button>
      )}
    </div>
  );
}

/** Предупреждение (жёлтая плашка). */
export function WarnBox({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-sm text-[var(--color-text)] ${className}`}>
      <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

export function Skeleton({ className = 'h-40' }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-[var(--color-border)] ${className}`} />;
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
