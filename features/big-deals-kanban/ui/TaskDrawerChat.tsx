'use client';
// Чат задачи прямо в канбане (встреча 11.11: «чат задачи прямо в канбане, шаблоны вопросов»).
// Лента — im.dialog.messages.get чата задачи (taskDetails.ts), отправка — action 'comment' от имени нажавшего.
import { useState } from 'react';
import { Paperclip, Send } from 'lucide-react';
import { AttachmentsRow, useAttachments } from '@/features/repeat-kanban/ui/Attachments';
import type { BigTaskCard } from '../engine/types';
import type { BigChatMessage } from '../engine/taskDetails';
import { fmtDT } from './format';
import { QUESTION_TEMPLATES } from './questionTemplates';
import { Section, postBigAction } from './TaskDrawerShared';

export function TaskChat({ card, messages, loading, onSent }: { card: BigTaskCard; messages: BigChatMessage[] | null; loading: boolean; onSent: (card?: BigTaskCard) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const att = useAttachments();
  const insert = (t: string) => setText(prev => (prev.trim() ? `${prev.trimEnd()}\n${t}` : t));
  const send = async () => {
    if (!text.trim() && !att.files.length) return;
    setBusy(true); setErr(null); setWarn(null);
    try {
      const attachments = await att.upload();
      const r = await postBigAction({ type: 'comment', taskId: card.id, text: text.trim(), attachments });
      setText(''); for (let i = att.files.length - 1; i >= 0; i--) att.remove(i);
      if (r.warnings?.length) setWarn(r.warnings.join(' '));
      onSent(r.card);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Section title="Чат задачи">
      <div className="flex max-h-[45dvh] min-h-24 flex-col gap-2 overflow-y-auto overflow-x-hidden pr-1">
        {loading && <p className="text-[var(--color-text-muted)]">Загружаю переписку…</p>}
        {messages?.length === 0 && <p className="text-[var(--color-text-muted)]">Сообщений пока нет</p>}
        {messages?.map(m => m.system ? (
          <p key={m.id} className="text-center text-[11.5px] text-[var(--color-text-muted)]">{m.text} · {fmtDT(m.at)}</p>
        ) : (
          <div key={m.id} className={`min-w-0 max-w-[90%] rounded-lg px-2.5 py-1.5 ${m.authorId === card.responsible.id ? 'self-start bg-[var(--color-bg-hover)]' : 'self-end bg-[var(--color-accent-soft)]'}`}>
            <div className="text-[11px] text-[var(--color-text-muted)]">{m.author ?? m.authorId} · {fmtDT(m.at)}</div>
            {m.text && <div className="whitespace-pre-wrap break-words">{m.text}</div>}
            {m.files?.map((f, i) => (
              <div key={i} className="flex min-w-0 items-center gap-1 text-[12.5px] text-[var(--color-text-secondary)]">
                <Paperclip size={12} className="shrink-0" aria-hidden /><span className="min-w-0 truncate">{f}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {QUESTION_TEMPLATES.map(q => (
          <button key={q.key} type="button" onClick={() => insert(q.text)}
            className="min-h-11 rounded-full border border-[var(--color-border)] px-3 text-[12px] hover:bg-[var(--color-bg-hover)] sm:min-h-8">
            {q.label}
          </button>
        ))}
      </div>
      <div className="mt-2 flex min-w-0 flex-col gap-2" {...att.dropZone}>
        <textarea value={text} onChange={e => setText(e.target.value)} onPaste={att.onPaste} rows={3}
          placeholder="Вопрос менеджеру — уйдёт в чат задачи от вашего имени"
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }}
          className={`w-full min-w-0 rounded-md border bg-transparent px-2.5 py-2 text-base sm:text-sm ${att.dragOver ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`} />
        <AttachmentsRow a={att} />
        {(err || att.error) && <p role="alert" className="text-[var(--color-negative)]">{err ?? att.error}</p>}
        {warn && <p role="status" className="text-[var(--color-warning)]">{warn}</p>}
        <button type="button" disabled={busy || (!text.trim() && !att.files.length)} onClick={send}
          className="inline-flex min-h-11 items-center justify-center gap-1.5 self-end rounded-md bg-[var(--color-accent)] px-4 text-sm font-medium text-white disabled:opacity-50">
          <Send size={14} /> {busy ? 'Отправляю…' : 'Отправить'}
        </button>
      </div>
    </Section>
  );
}
