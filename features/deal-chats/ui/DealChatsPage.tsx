'use client';
// Раздел «Чаты» (право action.deal_chats): все переписки текущего пользователя
// с менеджерами по сделкам. РОП, пройдясь по сделкам, наотправлял вопросов —
// здесь читает ответы в одном месте. Непрочитанные — сверху, с красной точкой.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { DealChatPanel } from '@/features/reports/ui/DealChatPanel';

interface ChatListItem {
  id: number;
  deal_id: number;
  deal_name: string | null;
  manager_name: string | null;
  status: 'sent' | 'replied';
  has_unread_reply: boolean;
  last_message_at: string;
  last_text: string | null;
  last_direction: 'out' | 'in' | null;
}

function fmtTimeMsk(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export function DealChatsPage() {
  const [openDeal, setOpenDeal] = useState<ChatListItem | null>(null);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['deal-chats-list'],
    queryFn: () => fetch('/api/deal-chats').then(r => r.json()) as Promise<{ chats: ChatListItem[] }>,
    refetchInterval: 30_000,
  });
  const chats = data?.chats ?? [];
  const unread = chats.filter(c => c.has_unread_reply).length;

  return (
    // <main> AppShell — overflow-hidden: скролл-контейнер страницы свой (как SummaryPage).
    <div className="h-full overflow-y-auto overflow-x-hidden">
    <div className="p-4 sm:p-6 max-w-3xl">
      <div className="flex items-baseline gap-3 mb-4">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Чаты по сделкам</h1>
        {unread > 0 && (
          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-[color-mix(in_srgb,var(--color-negative,#e03131)_12%,var(--color-mix-base,white))] text-[var(--color-negative,#e03131)]">
            {unread} непрочит.
          </span>
        )}
      </div>

      {isLoading && (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 bg-[var(--color-border)] rounded-xl animate-pulse" />)}</div>
      )}

      {!isLoading && chats.length === 0 && (
        <div className="border border-[var(--color-border)] rounded-xl p-8 text-center text-sm text-[var(--color-text-muted)]">
          <MessageCircle size={24} className="mx-auto mb-2 opacity-50" />
          Переписок пока нет. Откройте список сделок в отчёте и нажмите иконку
          сообщения справа от названия сделки — вопрос уйдёт менеджеру от бота «Аналитик».
        </div>
      )}

      <div className="flex flex-col gap-2">
        {chats.map(c => (
          <button
            key={c.id}
            onClick={() => setOpenDeal(c)}
            className={`text-left border rounded-xl px-4 py-3 transition-colors hover:bg-[var(--color-bg-hover)] ${
              c.has_unread_reply ? 'border-[var(--color-negative,#e03131)]' : 'border-[var(--color-border)]'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              {c.has_unread_reply && <span className="w-2 h-2 rounded-full bg-[var(--color-negative,#e03131)] shrink-0" />}
              <span className="font-medium text-sm text-[var(--color-text)] truncate">
                #{c.deal_id}{c.deal_name ? ` — ${c.deal_name}` : ''}
              </span>
              <span className="ml-auto shrink-0 text-[11px] text-[var(--color-text-muted)] tabular-nums">{fmtTimeMsk(c.last_message_at)}</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-[var(--color-text-muted)] min-w-0">
              <span className="shrink-0">{c.manager_name ?? '—'}</span>
              {c.last_text && (
                <span className="truncate">
                  · {c.last_direction === 'out' ? 'Вы: ' : ''}{c.last_text}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      {openDeal && (
        <DealChatPanel
          dealId={openDeal.deal_id}
          dealName={openDeal.deal_name}
          managerName={openDeal.manager_name}
          onClose={() => { setOpenDeal(null); void refetch(); }}
        />
      )}
    </div>
    </div>
  );
}
