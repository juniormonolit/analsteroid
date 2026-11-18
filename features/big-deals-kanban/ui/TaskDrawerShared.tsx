'use client';
// Общее для карточки задачи канбана больших чеков: секция и вызов действия.
import type { BigTaskCard } from '../engine/types';

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{title}</h3>
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
