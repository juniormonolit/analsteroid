'use client';
// Комментарий к карточке (Осипов 25.11: «поле комментарий в карточке, и чтоб выводилось на карточке в канбане»).
// Заметка РОПа на доске: в Битрикс не уходит, видна всем, кто видит задачу. PUT /api/big-deals-kanban/task/{id}/note.
import { useEffect, useState } from 'react';
import { StickyNote } from 'lucide-react';
import type { BigTaskCard, BigTaskNote } from '../engine/types';
import { fmtDT } from './format';
import { Section } from './TaskDrawerShared';

const MAX = 2000;

export function CardNoteField({ card, canEdit, onSaved, mock = false }: {
  card: BigTaskCard; canEdit: boolean; onSaved: (card: BigTaskCard) => void; mock?: boolean;
}) {
  const saved = card.note?.text ?? '';
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Другая карточка / комментарий обновился с доски — подтягиваем, если пользователь ничего не менял.
  useEffect(() => { setText(saved); setErr(null); }, [card.id, saved]);
  const dirty = text.trim() !== saved.trim();

  if (!canEdit && !saved) return null;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      let note: BigTaskNote | null;
      if (mock) note = text.trim() ? { text: text.trim(), author: 'Вы', at: new Date().toISOString() } : null;
      else {
        const r = await fetch(`/api/big-deals-kanban/task/${card.id}/note`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
        note = j.note ?? null;
      }
      onSaved({ ...card, note });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Section title="Комментарий">
      {canEdit ? (
        <div className="flex min-w-0 flex-col gap-2">
          <textarea value={text} onChange={e => setText(e.target.value.slice(0, MAX))} rows={2} maxLength={MAX}
            placeholder="Заметка к карточке — видна на доске всем, кто видит задачу. В Битрикс не уходит."
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && dirty && !busy) { e.preventDefault(); void save(); } }}
            className="w-full min-w-0 rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-2 text-base sm:text-sm" />
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 text-[11.5px] text-[var(--color-text-muted)]">
              {card.note ? `${card.note.author ?? '—'} · ${fmtDT(card.note.at)}` : 'Пока пусто'}
            </span>
            {dirty && (
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setText(saved)} disabled={busy}
                  className="inline-flex min-h-11 items-center rounded-md border border-[var(--color-border)] px-3 text-[13px] hover:bg-[var(--color-bg-hover)] disabled:opacity-50 sm:min-h-9">Отмена</button>
                <button type="button" onClick={() => void save()} disabled={busy}
                  className="inline-flex min-h-11 items-center rounded-md bg-[var(--color-accent)] px-4 text-[13px] font-medium text-white disabled:opacity-50 sm:min-h-9">
                  {busy ? 'Сохраняю…' : text.trim() ? 'Сохранить' : 'Удалить комментарий'}
                </button>
              </div>
            )}
          </div>
          {err && <p role="alert" className="text-[12.5px] text-[var(--color-negative)]">{err}</p>}
        </div>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-[13px]">{saved}</p>
          {card.note && <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">{card.note.author ?? '—'} · {fmtDT(card.note.at)}</p>}
        </>
      )}
    </Section>
  );
}

/** Строка комментария на карточке доски. */
export function CardNoteLine({ note }: { note: BigTaskNote }) {
  return (
    <div className="flex min-w-0 items-start gap-1 rounded bg-[var(--color-warning)]/10 px-1.5 py-1 text-[11.5px] leading-snug text-[var(--color-text)]"
      title={`${note.text}\n— ${note.author ?? ''}, ${fmtDT(note.at)}`}>
      <StickyNote size={11} className="mt-[2px] shrink-0 text-[var(--color-warning)]" aria-hidden />
      <span className="line-clamp-2 min-w-0 whitespace-pre-wrap break-words">{note.text}</span>
    </div>
  );
}
