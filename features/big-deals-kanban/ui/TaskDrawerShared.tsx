'use client';
// Общее для карточки задачи канбана больших чеков: секция и вызов действия.
import type { BigTaskCard } from '../engine/types';

/** Ссылка «в Битрикс» прямо там, где читаешь данные из Битрикса (владелец 25.11). */
export function BxLink({ href, children, title }: { href: string | null | undefined; children: React.ReactNode; title?: string }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" title={title ?? 'Открыть в Битриксе'}
      className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded px-1.5 text-[11.5px] font-normal normal-case tracking-normal text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
      {children}<span aria-hidden>↗</span>
    </a>
  );
}

export function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
      <h3 className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        <span className="min-w-0 flex-1">{title}</span>{extra}
      </h3>
      {children}
    </section>
  );
}

/** POST действия; ответ — свежая карточка. */
export async function postBigAction(body: Record<string, unknown>): Promise<{ card?: BigTaskCard; warnings?: string[] }> {
  const r = await fetch('/api/big-deals-kanban/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
  return j;
}
