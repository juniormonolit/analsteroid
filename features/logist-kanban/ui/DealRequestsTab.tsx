'use client';
// Вкладка «Запросы логисту» в карточке сделки Битрикса (CRM_DEAL_DETAIL_TAB, владелец 19.11) — /bx/deal-requests?deal=<id>.
// Вход — /api/bitrix/app/deal-requests (AUTH_ID → сессия, доступ к сделке проверен токеном сотрудника).
// Здесь ничего своего: список — GET /api/logist-kanban/deal/:id (видимость — правила канбана), карточка запроса —
// RequestDrawer S3 (варианты, «Принять вариант» с «было/станет», чат), новый / черновик / «дополнить» — форма S2
// LogistRequestForm. Без шапки и навигации приложения (embed-layout); ширина вкладки 375–900 px — одна колонка,
// с sm: две. Режим — useAppMode: в iframe ссылки «наружу» открываются новой вкладкой, а не внутри фрейма портала.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HelpCircle, Plus, RefreshCw, Send } from 'lucide-react';
import { useAppMode } from '@/lib/hooks/useAppMode';
import { REQUEST_STATUS_LABEL, REQUEST_TYPE_LABEL, type DealRequestsResponse, type RequestCard, type RequestType } from '../engine/requests/contract';
import { LogistRequestForm } from '../form/LogistRequestForm';
import { lkFetch, type LogistApiError } from './api';
import { RequestCardView } from './RequestCardView';
import { RequestDrawer } from './RequestDrawer';
import { STATUS_CLS } from './format';
import { installDealTabMock } from './dealTabMock';

const OPEN = new Set(['draft', 'new', 'in_work', 'answered']);
const BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium';

export function DealRequestsTab({ dealId, mock = false }: { dealId: number; mock?: boolean }) {
  if (mock && typeof window !== 'undefined') installDealTabMock(dealId);
  const qc = useQueryClient();
  const { isBitrixIframe } = useAppMode();
  const [reqId, setReqId] = useState<number | null>(null);
  const [form, setForm] = useState<{ requestId?: number } | null>(null);

  const qk = ['logist-deal-requests', dealId];
  const q = useQuery<DealRequestsResponse, LogistApiError>({
    queryKey: qk,
    queryFn: () => lkFetch<DealRequestsResponse>(`/api/logist-kanban/deal/${dealId}`),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const d = q.data;
  const refresh = () => { void qc.invalidateQueries({ queryKey: qk }); };
  const open = (c: RequestCard) => (c.status === 'draft' ? setForm({ requestId: c.id }) : setReqId(c.id));
  const active = (d?.requests ?? []).filter(c => OPEN.has(c.status));
  const closed = (d?.requests ?? []).filter(c => !OPEN.has(c.status));
  const openTypes = Object.entries(d?.openByType ?? {}) as [RequestType, number][];

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[900px] flex-col gap-3 overflow-x-hidden p-3 sm:p-4">
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
        <h1 className="min-w-0 text-base font-bold text-[var(--color-text)]">Запросы логисту</h1>
        {q.isFetching && !!d && <RefreshCw size={14} className="animate-spin text-[var(--color-text-muted)]" aria-label="обновляется" />}
        <span className="flex flex-wrap gap-1.5 sm:ml-auto">
          <button type="button" onClick={() => setForm({})} className={`${BTN} bg-[var(--color-accent)] text-white`}>
            <Plus size={16} aria-hidden /> Новый запрос
          </button>
          {/* гид — отдельной вкладкой браузера: внутри фрейма портала у него нет «назад» */}
          <a href="/logist-kanban/guide" target={isBitrixIframe ? '_blank' : undefined} rel="noopener noreferrer"
            className={`${BTN} border border-[var(--color-border)] font-normal text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`} aria-label="Как работать?">
            <HelpCircle size={16} aria-hidden /> <span className="hidden min-[420px]:inline">Как работать?</span>
          </a>
        </span>
      </header>

      {openTypes.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {openTypes.map(([t, id]) => (
            <button key={t} type="button" onClick={() => setForm({ requestId: id })}
              className={`${BTN} min-w-0 border border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-left text-[var(--color-accent)]`}>
              <Send size={15} className="shrink-0" aria-hidden />
              <span className="min-w-0 break-words">Дополнить №{id} · {REQUEST_TYPE_LABEL[t]}</span>
            </button>
          ))}
        </div>
      )}

      {q.error && (
        <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">
          {q.error.message}
          <button type="button" onClick={() => q.refetch()} className="ml-2 min-h-11 underline">Повторить</button>
        </div>
      )}
      {q.isLoading && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Загружаю запросы по сделке…</div>}
      {d && d.requests.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-5 text-center text-sm text-[var(--color-text-muted)]">
          По этой сделке запросов логисту нет. Нужна цена или срок на товар, которого нет в калькуляторе, или у заказчика цена
          конкурента — нажмите «Новый запрос»: товары сделки подставятся сами.
        </div>
      )}

      {active.length > 0 && <List title="Открытые" cards={active} onOpen={open} />}
      {closed.length > 0 && <List title="Закрытые" cards={closed} onOpen={open} />}

      {reqId !== null && (
        <RequestDrawer id={reqId} hint={d?.requests.find(c => c.id === reqId) ?? null} queues={d?.queues ?? []} me={d?.me?.bitrixId ?? null}
          onClose={() => setReqId(null)} onChanged={refresh} />
      )}
      <LogistRequestForm open={form !== null} onOpenChange={o => { if (!o) setForm(null); }}
        dealId={dealId} requestId={form?.requestId ?? null} onDone={refresh} />
    </div>
  );
}

function List({ title, cards, onOpen }: { title: string; cards: RequestCard[]; onOpen: (c: RequestCard) => void }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h2 className="text-[12.5px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{title} · {cards.length}</h2>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        {cards.map(c => (
          <div key={c.id} className="flex min-w-0 flex-col gap-1">
            {/* статус — на доске его даёт колонка, здесь колонок нет */}
            <span className={`self-start rounded-md px-2 py-0.5 text-[11.5px] font-medium ${STATUS_CLS[c.status]}`}>
              {REQUEST_STATUS_LABEL[c.status]}{c.status === 'answered' ? ' — примите вариант или верните' : c.status === 'draft' ? ' — дополните и отправьте' : ''}
            </span>
            <RequestCardView card={c} onOpen={onOpen} />
          </div>
        ))}
      </div>
    </section>
  );
}
