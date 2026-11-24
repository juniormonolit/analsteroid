'use client';
// Чат задачи прямо в канбане (встреча 11.11: «чат задачи прямо в канбане, шаблоны вопросов»).
// Лента — im.dialog.messages.get чата задачи (taskDetails.ts), отправка — action 'comment' от имени нажавшего.
import { useEffect, useState } from 'react';
import { AtSign, Paperclip, Send } from 'lucide-react';
import { AttachmentsRow, useAttachments } from '@/features/repeat-kanban/ui/Attachments';
import type { BigTaskCard } from '../engine/types';
import type { BigChatFile, BigChatMessage } from '../engine/taskDetails';
import { fmtDT } from './format';
import { QuestionsBlock } from './QuestionsBlock';
import { Section, postBigAction } from './TaskDrawerShared';

export function TaskChat({ card, messages, loading, onSent, questions, rop, inject, mock = false }: {
  card: BigTaskCard; messages: BigChatMessage[] | null; loading: boolean; onSent: (card?: BigTaskCard) => void;
  /** Вопросы из описания задачи — кнопками в блоке «Вопросы и шаблоны» (РОП 18.11: один блок вместо двух). */
  questions?: string[];
  /** РОП исполнителя — «Отметить РОПа». */
  rop?: { id: string; name: string } | null;
  /** Текст снаружи (ИИ-оценка: «Спросить по красным и жёлтым») — дописывается в черновик; key — чтобы сработал повтор. */
  inject?: { text: string; key: number } | null;
  mock?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const att = useAttachments();
  // Кого можно отметить: исполнитель, ответственный по сделке (если другой), РОП исполнителя.
  const mentions: { id: string; name: string; role: string }[] = [];
  const addM = (p: { id: string; name: string } | null | undefined, role: string) => {
    if (p?.id && /^\d+$/.test(p.id) && !mentions.some(m => m.id === p.id)) mentions.push({ id: p.id, name: p.name, role });
  };
  addM(card.responsible, 'исполнитель');
  addM(card.deal?.assigned, 'по сделке');
  addM(rop, 'РОП');
  // Упоминание РОПа — в начало строки через пробел, остальное — с новой строки.
  const insert = (t: string) => setText(prev => (!prev.trim() ? t : t.startsWith('[USER=') ? `${t}${prev.includes('\n') ? '\n' : ''}${prev.trimStart()}` : `${prev.trimEnd()}\n${t}`));
  useEffect(() => { if (inject?.text) insert(inject.text); }, [inject?.key]); // eslint-disable-line react-hooks/exhaustive-deps
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
            {m.files?.map((f, i) => <ChatFileLink key={i} file={f} />)}
          </div>
        ))}
      </div>
      <div className="mt-3">
        <QuestionsBlock questions={questions} deal={card.deal} mock={mock} onInsert={insert} />
      </div>
      {mentions.length > 0 && (
        // Осипов 23.11: «не пингануть РОПа, если не выбрал шаблон; не ставится ответственный менеджер» — упоминания
        // отдельной строкой, всегда на виду: Битрикс пришлёт отмеченному уведомление.
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] text-[var(--color-text-muted)]">Отметить:</span>
          {mentions.map(m => (
            <button key={m.id} type="button" onClick={() => insert(`[USER=${m.id}]${m.name}[/USER], `)} title={`Упомянуть: ${m.name} — Битрикс пришлёт уведомление`}
              className="inline-flex min-h-11 min-w-0 items-center gap-1 rounded-full border border-[var(--color-border)] px-3 text-[12.5px] hover:bg-[var(--color-bg-hover)] sm:min-h-8">
              <AtSign size={12} className="shrink-0" /><span className="truncate">{m.name}</span><span className="shrink-0 text-[var(--color-text-muted)]">· {m.role}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 flex min-w-0 flex-col gap-2" {...att.dropZone}>
        <textarea value={text} onChange={e => setText(e.target.value)} onPaste={att.onPaste} rows={3}
          placeholder="Вопрос менеджеру — уйдёт в чат задачи от вашего имени. Enter — отправить, Shift+Enter — новая строка. Картинку можно и без текста."
          // Enter — отправить, как в чате Битрикса (Осипов 24.11); Shift+Enter — перенос строки. Не во время набора IME.
          onKeyDown={e => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (!busy) void send();
          }}
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

/** Файл в ленте чата (Осипов 23.11: «не открыть файл из чата») — ссылка в Битрикс, имя вебхуку неизвестно. */
export function ChatFileLink({ file }: { file: BigChatFile }) {
  const label = file.name === 'файл' ? 'Файл — открыть в Битриксе' : file.name;
  return file.url ? (
    <a href={file.url} target="_blank" rel="noreferrer" title="Откроется в Битриксе (нужен вход в Битрикс)"
      className="flex min-h-8 min-w-0 items-center gap-1 text-[12.5px] text-[var(--color-accent)] underline">
      <Paperclip size={12} className="shrink-0" aria-hidden /><span className="min-w-0 truncate">{label}</span>
    </a>
  ) : (
    <div className="flex min-w-0 items-center gap-1 text-[12.5px] text-[var(--color-text-secondary)]">
      <Paperclip size={12} className="shrink-0" aria-hidden /><span className="min-w-0 truncate">{file.name}</span>
    </div>
  );
}
