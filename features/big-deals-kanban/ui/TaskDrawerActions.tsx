'use client';
// Действия РОПа в карточке задачи: назначить менеджера с ТЗ, перенести в колонку (для тача, где нет drag),
// «Принял, работаем дальше» (владелец 18.11: ответ увидел — задача возвращается в работу, НЕ закрывается) /
// вернуть на доработку (задача ждёт контроля), «Не продано → завершить». POST /api/big-deals-kanban/action.
// Закрытие задачи (перенос в AUTO_COMPLETE_COLUMNS, «Не продано → завершить») — только через ConfirmCloseModal.
import { useState } from 'react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { AUTO_COMPLETE_COLUMNS, BIG_COLUMNS, type BigColumnKey } from '../engine/config';
import type { BigPerson, BigTaskCard } from '../engine/types';
import { FIVE_QUESTIONS_TZ, QUESTION_TEMPLATES } from './questionTemplates';
import { Section, postBigAction } from './TaskDrawerShared';
import { ConfirmCloseModal } from './MassCloseModal';

type Mode = null | 'reassign' | 'return' | 'accept';
/** Ждёт подтверждения закрытия: перенос в закрывающую колонку или «Не продано → завершить». */
type PendingClose = null | { type: 'move'; column: BigColumnKey } | { type: 'complete' };

const btn = 'inline-flex min-h-11 items-center justify-center rounded-md border border-[var(--color-border)] px-3 text-[13px] hover:bg-[var(--color-bg-hover)] disabled:opacity-50';
const primary = 'inline-flex min-h-11 items-center justify-center rounded-md bg-[var(--color-accent)] px-4 text-[13px] font-medium text-white disabled:opacity-50';
const input = 'w-full min-w-0 rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-2 text-base sm:text-sm';

export function TaskActions({ card, managers, onChanged }: { card: BigTaskCard; managers: BigPerson[]; onChanged: (card?: BigTaskCard) => void }) {
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [manager, setManager] = useState('');
  const [tz, setTz] = useState('');
  const [comment, setComment] = useState('');
  const [deadline, setDeadline] = useState('');
  const [pending, setPending] = useState<PendingClose>(null);
  const closed = card.state === 'done';

  const run = async (body: Record<string, unknown>) => {
    setBusy(true); setErr(null); setWarn(null);
    try {
      const r = await postBigAction({ taskId: card.id, ...body });
      if (r.warnings?.length) setWarn(r.warnings.join('; '));
      setMode(null); setTz(''); setComment(''); setDeadline(''); setManager('');
      setPending(null);
      onChanged(r.card);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setPending(null); }
    finally { setBusy(false); }
  };

  const managerOptions = managers.map(m => ({ value: m.id, label: m.name }));
  const columnOptions = BIG_COLUMNS.filter(c => c.key !== card.column).map(c => ({ value: c.key, label: c.title, hint: c.hint ?? null }));
  const addTz = (t: string) => setTz(prev => (prev.trim() ? `${prev.trimEnd()}\n${t}` : t));

  return (
    <Section title="Действия">
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {!closed && <button type="button" className={btn} disabled={busy} onClick={() => setMode(mode === 'reassign' ? null : 'reassign')}>Назначить менеджера</button>}
          <SearchSelect options={columnOptions} value="" placeholder="Перенести в…" ariaLabel="Перенести в колонку" disabled={busy}
            className="min-h-11 w-full" onChange={v => {
              if (!v) return;
              const column = v as BigColumnKey;
              if (AUTO_COMPLETE_COLUMNS.has(column) && !closed) setPending({ type: 'move', column });
              else void run({ type: 'move', column });
            }} />
          {card.state === 'control' && <button type="button" className={primary} disabled={busy} onClick={() => setMode(mode === 'accept' ? null : 'accept')} title="Ответ увидел — задача вернётся менеджеру в работу, не закроется">Принял, работаем дальше</button>}
          {card.state === 'control' && <button type="button" className={btn} disabled={busy} onClick={() => setMode(mode === 'return' ? null : 'return')}>Вернуть на доработку</button>}
          {!closed && <button type="button" className={`${btn} text-[var(--color-negative)]`} disabled={busy} onClick={() => setPending({ type: 'complete' })}>Не продано → завершить</button>}
        </div>

        {mode === 'reassign' && (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] p-2.5">
            <SearchSelect options={managerOptions} value={manager} onChange={setManager} placeholder="Выберите менеджера" searchable ariaLabel="Менеджер" className="min-h-11 w-full" />
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => addTz(FIVE_QUESTIONS_TZ)} className="min-h-11 rounded-full border border-[var(--color-accent)] px-3 text-[12px] text-[var(--color-accent)] sm:min-h-8">5 вопросов</button>
              {QUESTION_TEMPLATES.map(q => (
                <button key={q.key} type="button" onClick={() => addTz(q.text)} className="min-h-11 rounded-full border border-[var(--color-border)] px-3 text-[12px] hover:bg-[var(--color-bg-hover)] sm:min-h-8">{q.label}</button>
              ))}
            </div>
            <textarea value={tz} onChange={e => setTz(e.target.value)} rows={4} placeholder="ТЗ менеджеру — уйдёт в чат задачи" className={input} />
            <button type="button" className={`${primary} self-end`} disabled={busy || !manager} onClick={() => run({ type: 'reassign', responsibleId: manager, comment: tz.trim() || undefined })}>
              {busy ? 'Назначаю…' : 'Назначить'}
            </button>
          </div>
        )}

        {mode === 'return' && (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] p-2.5">
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} placeholder="Что доделать" className={input} />
            <label className="flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)]">
              Новый срок (необязательно)
              <input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)} className={input} />
            </label>
            <button type="button" className={`${primary} self-end`} disabled={busy || comment.trim().length < 3}
              onClick={() => run({ type: 'return', comment: comment.trim(), deadline: deadline ? new Date(deadline).toISOString() : undefined })}>
              {busy ? 'Возвращаю…' : 'Вернуть'}
            </button>
          </div>
        )}

        {mode === 'accept' && (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] p-2.5">
            <p className="text-[12px] text-[var(--color-text-muted)]">Задача вернётся менеджеру в работу (не закроется), в чат уйдёт «РОП посмотрел ответ, работаем дальше». Закрыть — «Не продано → завершить» или перенос в «Продано».</p>
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder="Комментарий менеджеру (необязательно)" className={input} />
            <label className="flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)]">
              Новый срок (необязательно)
              <input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)} className={input} />
            </label>
            <button type="button" className={`${primary} self-end`} disabled={busy}
              onClick={() => run({ type: 'accept', comment: comment.trim() || undefined, deadline: deadline ? new Date(deadline).toISOString() : undefined })}>
              {busy ? 'Отправляю…' : 'Принял, работаем дальше'}
            </button>
          </div>
        )}

        {pending && (
          <ConfirmCloseModal count={1} busy={busy} onCancel={() => setPending(null)}
            title={pending.type === 'complete' ? 'Не продано — завершить задачу?' : `Перенести в «${BIG_COLUMNS.find(c => c.key === pending.column)?.title}» и закрыть?`}
            onConfirm={() => void run(pending.type === 'complete' ? { type: 'complete' } : { type: 'move', column: pending.column })} />
        )}

        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        {warn && <p className="text-[var(--color-warning)]">{warn}</p>}
      </div>
    </Section>
  );
}
