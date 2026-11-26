import type { AssignmentState } from '../types';

export const STATE_LABEL: Record<AssignmentState, string> = {
  assigned: 'Назначен', in_progress: 'Проходит', passed: 'Сдал', failed: 'Не сдал', overdue: 'Просрочен', cancelled: 'Снят',
};
export const STATE_CLS: Record<AssignmentState, string> = {
  assigned: 'bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]',
  in_progress: 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]',
  passed: 'bg-[var(--color-positive)]/12 text-[var(--color-positive)]',
  failed: 'bg-[var(--color-negative)]/10 text-[var(--color-negative)]',
  overdue: 'bg-[var(--color-negative)]/10 text-[var(--color-negative)]',
  cancelled: 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]',
};

const dtf = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' });
const dtfTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const fmtDay = (iso: string) => dtf.format(new Date(iso));
export const fmtDayTime = (iso: string) => dtfTime.format(new Date(iso));
export const fmtScore = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x)}%`);
export const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

export const BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-sm font-medium hover:bg-[var(--color-bg-hover)] disabled:opacity-50';
export const BTN_PRIMARY = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50';
export const INPUT = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base sm:text-sm';
