'use client';
// «Запросы логистам» в ЛК (S5, LOGIST_REQUESTS_SPEC.md): вкладка «Мои» — свои запросы менеджера по статусам, сверху то,
// что ждёт его действия (ответ пришёл — принять/вернуть, вопрос в чате, неотправленный черновик); вкладка «Аналитика» —
// РОПу (своя зона) и руководителю логистики/админу (всё).
// Переиспользует S3/S2, ничего не дублирует: карточка в списке — RequestCardView, открытый запрос — RequestDrawer
// (?req=<id> — сюда же ведут ссылки бота «Аналитик» менеджеру), новый запрос и «дополнить черновик» — форма S2
// LogistRequestForm (по номеру сделки). Данные — GET /api/logist-kanban/my.
// Группы — чипами с переносом строки (правило 12 — без горизонтальной ленты), вкладки «Мои / Аналитика» — тоже.
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, HelpCircle, Inbox, Plus, RefreshCw } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { enumParam, intParam, useUrlState } from '@/lib/hooks/useUrlState';
import type { MyAttention, MyRequestsResponse, RequestCard } from '../engine/requests/contract';
import { LogistRequestForm } from '../form/LogistRequestForm';
import { lkFetch, type LogistApiError } from './api';
import { AnalyticsView } from './AnalyticsView';
import { BTN_IDLE } from './FiltersPanel';
import { RequestCardView } from './RequestCardView';
import { RequestDrawer } from './RequestDrawer';

const TABS = ['my', 'analytics'] as const;
const GROUPS = ['attention', 'waiting', 'draft', 'closed', 'all'] as const;
type Group = (typeof GROUPS)[number];
type MyCard = MyRequestsResponse['cards'][number];

const GROUP_LABEL: Record<Group, string> = {
  attention: 'Ждут меня', waiting: 'У логиста', draft: 'Черновики', closed: 'Закрытые', all: 'Все',
};
const GROUP_HINT: Record<Group, string> = {
  attention: 'Логист ответил — примите вариант или верните на доработку; или в чате новое сообщение',
  waiting: 'Запрос в очереди или логист ищет цену — от вас ничего не нужно',
  draft: 'Не отправлены логисту — дополните и отправьте',
  closed: 'Принятые и отменённые за 90 дней',
  all: 'Все ваши запросы за 90 дней и открытые',
};
const ATTN: Record<NonNullable<MyAttention>, { text: string; cls: string }> = {
  answered: { text: 'Ответ пришёл — принять или вернуть', cls: 'bg-[var(--success-bg)] text-[var(--color-positive)]' },
  chat: { text: 'Новое сообщение в чате', cls: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' },
  draft: { text: 'Черновик — дополнить и отправить', cls: 'bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]' },
};

const inGroup = (c: MyCard, g: Group): boolean => {
  switch (g) {
    case 'attention': return c.attention === 'answered' || c.attention === 'chat';
    case 'waiting': return (c.status === 'new' || c.status === 'in_work') && c.attention !== 'chat';
    case 'draft': return c.status === 'draft';
    case 'closed': return c.status === 'accepted' || c.status === 'cancelled';
    default: return true;
  }
};

export function MyRequestsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useUrlState('tab', { ...enumParam(TABS, 'my'), mode: 'push' });
  const [reqId, setReqId] = useUrlState('req', { ...intParam(0), mode: 'push' });
  const [groupParam, setGroup] = useUrlState('group', enumParam(GROUPS, 'attention'));
  const [newOpen, setNewOpen] = useState(false);
  const [draftId, setDraftId] = useState<number | null>(null);

  const q = useQuery<MyRequestsResponse, LogistApiError>({
    queryKey: ['logist-my'],
    queryFn: () => lkFetch<MyRequestsResponse>('/api/logist-kanban/my'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const d = q.data;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['logist-my'] }); void qc.invalidateQueries({ queryKey: ['logist-my-count'] }); };
  // пусто в «Ждут меня» — сразу показываем, что у логиста (первый заход не должен быть пустым экраном)
  const group: Group = d && groupParam === 'attention' && !d.counts.attention && !d.counts.draft ? (d.counts.waiting ? 'waiting' : 'all') : groupParam;
  const cards = (d?.cards ?? []).filter(c => inGroup(c, group));
  const count = (g: Group) => (d ? (g === 'all' ? d.cards.length : g === 'attention' ? d.counts.attention : g === 'waiting' ? d.cards.filter(c => inGroup(c, 'waiting')).length : g === 'draft' ? d.counts.draft : d.counts.closed) : 0);
  const open = (c: RequestCard) => (c.status === 'draft' ? setDraftId(c.id) : setReqId(c.id));
  const chip = (on: boolean) => `inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`;
  const tabCls = (on: boolean) => `inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-sm ${on ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`;
  const hint = d?.cards.find(c => c.id === reqId) ?? null;

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1200px] flex-col gap-3 p-3 sm:p-5">
      <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-extrabold text-[var(--color-text)]">Запросы логистам</h1>
        {q.isFetching && !!d && <RefreshCw size={14} className="animate-spin text-[var(--color-text-muted)]" aria-label="обновляется" />}
        <span className="flex flex-wrap gap-1.5 sm:ml-auto">
          <button type="button" onClick={() => setNewOpen(true)}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-white">
            <Plus size={16} aria-hidden /> Новый запрос
          </button>
          <Link href="/profile/logist-requests/guide" className={BTN_IDLE} aria-label="Как работать?">
            <HelpCircle size={16} aria-hidden /> <span className="hidden min-[420px]:inline">Как работать?</span>
          </Link>
        </span>
      </header>

      {d?.canAnalytics && (
        <div className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg border border-[var(--color-border)] p-0.5" role="tablist" aria-label="Раздел">
          <button type="button" role="tab" aria-selected={tab === 'my'} onClick={() => setTab('my')} className={tabCls(tab === 'my')}>
            <Inbox size={15} aria-hidden /> Мои запросы
          </button>
          <button type="button" role="tab" aria-selected={tab === 'analytics'} onClick={() => setTab('analytics')} className={tabCls(tab === 'analytics')}>
            <BarChart3 size={15} aria-hidden /> Аналитика
          </button>
        </div>
      )}

      {tab === 'analytics' && !d && !q.error ? (
        <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Загружаю…</div>
      ) : tab === 'analytics' && d?.canAnalytics ? <AnalyticsView /> : (
        <>
          <div className="flex min-w-0 flex-wrap gap-1.5" role="group" aria-label="Какие запросы показать">
            {GROUPS.map(g => (
              <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)} title={GROUP_HINT[g]} className={chip(group === g)}>
                {GROUP_LABEL[g]}
                <span className={`tabular-nums ${g === 'attention' && count(g) ? 'rounded-full bg-[var(--color-positive)] px-1.5 text-[11px] font-bold text-white' : 'opacity-70'}`}>{count(g)}</span>
              </button>
            ))}
          </div>
          <p className="text-[12.5px] text-[var(--color-text-muted)]">{GROUP_HINT[group]}</p>

          {q.error && (
            <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">
              {q.error.message}
              <button type="button" onClick={() => q.refetch()} className="ml-2 min-h-11 underline">Повторить</button>
            </div>
          )}
          {q.isLoading && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Загружаю запросы…</div>}
          {d && cards.length === 0 && (
            <div className="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">
              {d.cards.length === 0
                ? <>Запросов логистам у вас пока нет. Нужна цена или срок на товар, которого нет в калькуляторе, или у заказчика цена конкурента — нажмите «Новый запрос» или переведите сделку на стадию «Сделал запрос снабженцу» / «Есть цена дешевле».</>
                : 'Здесь пусто.'}
            </div>
          )}

          <div className="grid min-w-0 grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map(c => (
              <div key={c.id} className="flex min-w-0 flex-col gap-1">
                {c.attention && (
                  <span className={`self-start rounded-md px-2 py-0.5 text-[11.5px] font-medium ${ATTN[c.attention].cls}`}>{ATTN[c.attention].text}</span>
                )}
                <RequestCardView card={c} onOpen={open} />
              </div>
            ))}
          </div>
        </>
      )}

      {reqId > 0 && (
        <RequestDrawer id={reqId} hint={hint} queues={d?.queues ?? []} me={d?.me.bitrixId ?? null}
          onClose={() => setReqId(0)} onChanged={refresh} />
      )}
      <NewRequestDialog open={newOpen} onOpenChange={setNewOpen} onDone={refresh} />
      <LogistRequestForm open={draftId !== null} onOpenChange={o => { if (!o) setDraftId(null); }} requestId={draftId}
        onDone={() => { refresh(); }} />
    </div>
  );
}

/** «Новый запрос» — форма S2 работает от сделки: сначала номер сделки, потом сама форма (шапка и товары — из Битрикса). */
function NewRequestDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [raw, setRaw] = useState('');
  const [dealId, setDealId] = useState<number | null>(null);
  const parsed = (() => {
    // номер или ссылка на сделку (…/crm/deal/details/12345/)
    const m = raw.match(/deal\/details\/(\d+)/) ?? raw.trim().match(/^#?(\d{1,12})$/);
    return m ? Number(m[1]) : null;
  })();
  const close = (o: boolean) => { if (!o) { setRaw(''); setDealId(null); } onOpenChange(o); };
  if (dealId) {
    return <LogistRequestForm open={open} onOpenChange={close} dealId={dealId} onDone={() => { onDone(); }} />;
  }
  return (
    <Modal open={open} onOpenChange={close} title="Новый запрос логисту" desktopWidth="sm:max-w-md">
      <form className="flex min-w-0 flex-col gap-3" onSubmit={e => { e.preventDefault(); if (parsed) setDealId(parsed); }}>
        <label className="flex min-w-0 flex-col gap-1 text-[13px] text-[var(--color-text-secondary)]">
          Номер сделки или ссылка на неё
          <input autoFocus value={raw} onChange={e => setRaw(e.target.value)} inputMode="numeric" placeholder="например, 123456"
            className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-border-focus)] sm:text-sm" />
        </label>
        <p className="text-[12px] text-[var(--color-text-muted)]">
          Шапку и товары сделки форма подтянет из Битрикса — останется добавить то, чего нет в 1С, адрес, дату и комментарий.
        </p>
        <button type="submit" disabled={!parsed} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white disabled:opacity-50">
          Дальше
        </button>
      </form>
    </Modal>
  );
}
