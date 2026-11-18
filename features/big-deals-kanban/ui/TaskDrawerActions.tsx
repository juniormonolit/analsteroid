'use client';
// Действия РОПа в карточке задачи: назначить менеджера с ТЗ, перенести в колонку (для тача, где нет drag),
// принять / вернуть на доработку (задача ждёт контроля), «Не продано → завершить». POST /api/big-deals-kanban/action.
import { useState } from 'react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { BIG_COLUMNS, type BigColumnKey } from '../engine/config';
import type { BigPerson, BigTaskCard } from '../engine/types';
import { FIVE_QUESTIONS_TZ, QUESTION_TEMPLATES } from './questionTemplates';
import { Section, postBigAction } from './TaskDrawerShared';

type Mode = null | 'reassign' | 'return' | 'lost';

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
  const closed = card.state === 'done';

  const run = async (body: Record<string, unknown>) => {
    setBusy(true); setErr(null); setWarn(null);
    try {
      const r = await postBigAction({ taskId: card.id, ...body });
      if (r.warnings?.length) setWarn(r.warnings.join('; '));
      setMode(null); setTz(''); setComment(''); setDeadline(''); setManager('');
      onChanged(r.card);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
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
            className="min-h-11 w-full" onChange={v => { if (v) void run({ type: 'move', column: v as BigColumnKey }); }} />
          {card.state === 'control' && <button type="button" className={primary} disabled={busy} onClick={() => run({ type: 'accept' })}>Принять</button>}
          {card.state === 'control' && <button type="button" className={btn} disabled={busy} onClick={() => setMode(mode === 'return' ? null : 'return')}>Вернуть на доработку</button>}
          {!closed && <button type="button" className={`${btn} text-[var(--color-negative)]`} disabled={busy} onClick={() => setMode(mode === 'lost' ? null : 'lost')}>Не продано → завершить</button>}
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

        {mode === 'lost' && (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--color-negative)] p-2.5">
            <p>Задача переедет в «Не продано (проверка)» и будет завершена в Битриксе. Сделку это не закрывает.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={btn} onClick={() => setMode(null)}>Отмена</button>
              <button type="button" className="inline-flex min-h-11 items-center rounded-md bg-[var(--color-negative)] px-4 text-[13px] font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => run({ type: 'complete' })}>
                {busy ? 'Завершаю…' : 'Завершить'}
              </button>
            </div>
          </div>
        )}

        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        {warn && <p className="text-[var(--color-warning)]">{warn}</p>}
      </div>
    </Section>
  );
}
