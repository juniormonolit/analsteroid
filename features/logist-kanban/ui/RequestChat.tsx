'use client';
// Чат запроса: сообщения участников + служебные события журнала («взял», «ответил», «вернул») одной лентой.
// Новые сообщения подтягивает карточка (опрос раз в 20 с, RequestDrawer); отправка — POST /messages.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import type { ChatMessage, RequestEvent } from '../engine/requests/contract';
import { CHAT_EVENT_KINDS, eventText } from './events';
import { fmtDT, fmtTime } from './format';

type Row = { at: string; key: string } & ({ msg: ChatMessage } | { ev: RequestEvent });

export function RequestChat({ messages, events, me, canPost, busy, onSend, queueName, offerN }: {
  messages: ChatMessage[]; events: RequestEvent[]; me: string | null; canPost: boolean; busy: boolean;
  onSend: (text: string) => Promise<boolean>; queueName: (id: number) => string | null; offerN: (id: number) => number | null;
}) {
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const rows = useMemo<Row[]>(() => [
    ...messages.filter(m => !m.deleted).map(m => ({ at: m.createdAt, key: `m${m.id}`, msg: m })),
    ...events.filter(e => CHAT_EVENT_KINDS.has(e.kind)).map(e => ({ at: e.at, key: `e${e.id}`, ev: e })),
  ].sort((a, b) => a.at.localeCompare(b.at)), [messages, events]);
  const last = rows[rows.length - 1]?.key;
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [last]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    if (await onSend(t)) setText('');
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex min-h-40 min-w-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden rounded-lg bg-[var(--color-bg-surface)] p-2.5">
        {rows.length === 0 && <div className="m-auto text-center text-xs text-[var(--color-text-muted)]">Сообщений пока нет — спросите здесь, что уточнить по запросу.</div>}
        {rows.map(r => {
          if ('ev' in r) {
            return (
              <div key={r.key} className="self-center rounded-full bg-[var(--color-bg)] px-3 py-1 text-center text-[11.5px] text-[var(--color-text-muted)]">
                {eventText(r.ev, queueName, offerN)} · {fmtDT(r.at)}
              </div>
            );
          }
          const m = r.msg;
          const mine = !!me && m.author?.bitrixId === me;
          return (
            <div key={r.key} className={`flex max-w-[85%] min-w-0 flex-col gap-0.5 ${mine ? 'self-end items-end' : 'self-start'}`}>
              {!mine && <span className="px-1 text-[11px] font-medium text-[var(--color-text-secondary)]">{m.author?.name ?? m.authorLogin ?? '—'}</span>}
              <div className={`whitespace-pre-wrap break-words rounded-xl px-3 py-1.5 text-[13px] ${mine ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg)] text-[var(--color-text)]'}`}>
                {m.body}
              </div>
              <span className="px-1 text-[10.5px] text-[var(--color-text-muted)]" title={fmtDT(m.createdAt)}>{fmtTime(m.createdAt)}{m.editedAt ? ' · изм.' : ''}</span>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {canPost && (
        <div className="flex min-w-0 items-end gap-2">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder="Сообщение менеджеру и логисту…" aria-label="Сообщение"
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
            className="min-h-11 min-w-0 flex-1 resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-border-focus)] sm:text-sm" />
          <button type="button" onClick={() => void send()} disabled={busy || !text.trim()} aria-label="Отправить"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-[var(--color-accent)] text-white disabled:opacity-50"><Send size={16} /></button>
        </div>
      )}
    </div>
  );
}
