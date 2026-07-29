'use client';
// Сайдбар «Сообщение менеджеру» (чаты по сделкам, право action.deal_chats):
// РОП пишет ответственному менеджеру сделки через бота «Аналитик», здесь же
// виден весь тред (ответы менеджера прилетают через вебхук событий бота).
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Send, ExternalLink, X } from 'lucide-react';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SlideBackdrop } from '@/components/ui/SlideBackdrop';

interface ThreadMessage {
  id: number;
  direction: 'out' | 'in';
  author_name: string;
  text: string;
  created_at: string;
}
interface Thread {
  chat: { id: number; deal_id: number; deal_name: string | null; manager_name: string | null; status: string };
  messages: ThreadMessage[];
}

function fmtTimeMsk(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export function DealChatPanel({ dealId, dealName, managerName, onClose }: {
  dealId: number;
  dealName?: string | null;
  managerName?: string | null;
  onClose: () => void;
}) {
  const { closing, requestClose } = useSlideClose(onClose);
  const [text, setText] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['deal-chat-thread', dealId],
    queryFn: () => fetch(`/api/deal-chats/thread?dealId=${dealId}`).then(r => r.json()) as Promise<{ thread: Thread | null }>,
    refetchInterval: 20_000, // ответ менеджера может прийти, пока панель открыта
  });
  const thread = data?.thread ?? null;

  const send = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/deal-chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealId, text: text.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Не удалось отправить');
      return body;
    },
    onSuccess: () => {
      setText('');
      queryClient.invalidateQueries({ queryKey: ['deal-chat-thread', dealId] });
      queryClient.invalidateQueries({ queryKey: ['deal-chat-statuses'] });
      queryClient.invalidateQueries({ queryKey: ['deal-chats-list'] });
    },
  });

  const title = dealName ?? thread?.chat.deal_name ?? '';
  const manager = managerName ?? thread?.chat.manager_name ?? null;

  return (
    <>
      <SlideBackdrop closing={closing} onClick={requestClose} className="z-[75]" />
      <div className={`fixed inset-y-0 right-0 z-[80] w-full sm:w-[440px] sm:max-w-[94vw] bg-[var(--color-bg-surface)] shadow-2xl border-l border-[var(--color-border)] flex flex-col ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}>
        <PanelCloseTab onClick={requestClose} />

        <div className="shrink-0 border-b border-[var(--color-border)] px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-[var(--color-text-muted)]">Сообщение менеджеру{manager ? ` · ${manager}` : ''}</div>
            <a
              href={`https://td.monolit-crm.ru/crm/deal/details/${dealId}/`}
              target="_blank" rel="noopener noreferrer"
              className="font-semibold text-sm text-[var(--color-text)] hover:text-[var(--color-accent)] hover:underline inline-flex items-center gap-1 mt-0.5"
            >
              <span className="truncate">#{dealId}{title ? ` — ${title}` : ''}</span>
              <ExternalLink size={12} className="shrink-0 opacity-60" />
            </a>
          </div>
          <button onClick={requestClose} className="tap-target p-1.5 hover:bg-[var(--color-bg-hover)] rounded-lg transition-colors shrink-0 sm:hidden"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
          {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
          {!isLoading && !thread && (
            <div className="text-sm text-[var(--color-text-muted)]">
              Переписки по этой сделке ещё нет. Напишите вопрос — бот «Аналитик» доставит его
              ответственному менеджеру с подписью, от кого он.
            </div>
          )}
          {thread?.messages.map(m => (
            <div key={m.id} className={`max-w-[85%] ${m.direction === 'out' ? 'self-end' : 'self-start'}`}>
              <div className={`rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                m.direction === 'out'
                  ? 'bg-[color-mix(in_srgb,var(--color-accent)_14%,var(--color-mix-base,white))] text-[var(--color-text)]'
                  : 'bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)]'
              }`}>
                {m.text}
              </div>
              <div className={`mt-0.5 text-[11px] text-[var(--color-text-muted)] ${m.direction === 'out' ? 'text-right' : ''}`}>
                {m.author_name} · {fmtTimeMsk(m.created_at)}
              </div>
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-[var(--color-border)] p-4">
          {send.isError && (
            <div className="mb-2 text-xs text-[var(--color-negative,#e03131)]">{(send.error as Error).message}</div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && !send.isPending) send.mutate();
              }}
              rows={3}
              placeholder="Вопрос менеджеру по этой сделке…"
              className="flex-1 resize-none rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base sm:text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
            />
            <button
              onClick={() => send.mutate()}
              disabled={!text.trim() || send.isPending}
              className="tap-target shrink-0 p-2.5 rounded-xl bg-[var(--color-accent)] text-[var(--color-text-inverse)] disabled:opacity-40 transition-opacity"
              title="Отправить (Ctrl+Enter)"
            >
              <Send size={16} />
            </button>
          </div>
          <div className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
            Отправит бот «Аналитик» в личку менеджеру с подписью от вашего имени.
          </div>
        </div>
      </div>
    </>
  );
}
