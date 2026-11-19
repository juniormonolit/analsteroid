'use client';
// Карточка запроса логисту (как задача Битрикса, только лучше) — по образцу TaskDrawer канбана больших чеков.
// GET /api/logist-kanban/request/:id (без peek — чат прочитан) раз в 20 с, действия — POST …/action с version
// (оптимистичная блокировка: 409 conflict → перечитываем). Кнопки рисуются строго по details.can.
// Компьютер (md+): слева «Запрос / Варианты / История», справа чат. Телефон: чат — отдельной вкладкой.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Flame } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { TabsRibbon } from '@/features/client-module/ui/CardHeader';
import { Section } from '@/features/big-deals-kanban/ui/TaskDrawerShared';
import {
  REQUEST_STATUS_LABEL, REQUEST_TYPE_LABEL,
  type ActionBody, type ItemInput, type Offer, type QueueRef, type QueuesResponse, type RequestCard, type RequestDetails,
} from '../engine/requests/contract';
import { LogistApiError, lkFetch, postAction, postMessage } from './api';
import { eventText } from './events';
import { INPUT, OfferCard, OfferForm } from './Offers';
import { RequestChat } from './RequestChat';
import { AcceptOfferDialog, PreviewBody, usePreview } from './AcceptOffer';
import { SLA_CLS, STATUS_CLS, TYPE_META, cardTitle, fmtDT, fmtDate, hours, money, qty, slaText } from './format';

type Pane = 'request' | 'offers' | 'chat' | 'history';
type Dialog =
  | { kind: 'return' } | { kind: 'cancel' } | { kind: 'release' } | { kind: 'transfer' } | { kind: 'reassign' } | { kind: 'add_items' }
  | { kind: 'accept'; offer: Offer } | { kind: 'withdraw'; offer: Offer } | { kind: 'send' } | { kind: 'rewrite' };

const linkBtn = 'inline-flex min-h-11 items-center gap-1 rounded-md border border-[var(--color-border)] px-3 text-xs hover:bg-[var(--color-bg-hover)] sm:min-h-8';
const BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium disabled:opacity-50';
const BTN_PRIMARY = `${BTN} bg-[var(--color-accent)] text-white`;
const BTN_PLAIN = `${BTN} border border-[var(--color-border)] font-normal text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`;
const BTN_DANGER = `${BTN} border border-[var(--color-border)] font-normal text-[var(--color-negative)] hover:bg-[var(--color-negative-soft)]`;

export function RequestDrawer({ id, hint, queues, me, onClose, onChanged }: {
  id: number; hint: RequestCard | null; queues: QueueRef[]; me: string | null; onClose: () => void; onChanged: () => void;
}) {
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [pane, setPane] = useState<Pane>('request');
  const [answering, setAnswering] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const qk = ['logist-request', id];
  const q = useQuery<RequestDetails, LogistApiError>({
    queryKey: qk,
    queryFn: () => lkFetch<RequestDetails>(`/api/logist-kanban/request/${id}`),
    refetchInterval: 20_000,
    retry: (n, e) => n < 2 && e.status >= 500,
  });
  const d = q.data;
  const head: RequestCard | null = d ?? hint;
  const queueName = (qid: number) => queues.find(x => x.id === qid)?.name ?? null;
  const offerN = (oid: number) => d?.offers.find(o => o.id === oid)?.n ?? null;

  const flash = (text: string, bad = false) => { setToast({ text, bad }); setTimeout(() => setToast(null), bad ? 6000 : 3000); };
  const act = async (body: ActionBody, okText?: string): Promise<boolean> => {
    if (!d) return false;
    setBusy(true);
    try {
      const res = await postAction(id, { ...body, version: d.version } as ActionBody);
      qc.setQueryData(qk, res);
      onChanged();
      if (res.dealRows && res.dealRows.status === 'error') flash(`Принято, но товары сделки не переписаны: ${res.dealRows.error ?? 'ошибка Битрикса'}`, true);
      else if (okText) flash(okText);
      return true;
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Не получилось', true);
      if (e instanceof LogistApiError && e.status === 409) void q.refetch();
      return false;
    } finally { setBusy(false); }
  };
  const sendMessage = async (text: string) => {
    setBusy(true);
    try {
      await postMessage(id, text);
      await q.refetch();
      onChanged();
      return true;
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Сообщение не отправлено', true);
      return false;
    } finally { setBusy(false); }
  };

  const tabs = useMemo(() => {
    const t: { key: Pane; label: string; count?: number }[] = [
      { key: 'request', label: 'Запрос', count: d?.items.length },
      { key: 'offers', label: 'Варианты', count: d?.offers.filter(o => o.status !== 'withdrawn').length },
    ];
    if (isMobile) t.push({ key: 'chat', label: 'Чат', count: d?.messages.filter(m => !m.deleted).length });
    t.push({ key: 'history', label: 'История' });
    return t;
  }, [d, isMobile]);
  const left: Pane = pane === 'chat' && !isMobile ? 'request' : pane;
  const can = d?.can;

  return (
    <>
      <Modal open onOpenChange={o => { if (!o) onClose(); }}
        desktopWidth="sm:max-w-[1200px] sm:w-[96vw]"
        contentClassName="flex h-[94dvh] max-h-[94dvh] flex-col overflow-hidden sm:h-[92vh] sm:max-h-[92vh]"
        bodyClassName="flex min-h-0 flex-1 flex-col p-0"
        title={<span className="line-clamp-2 break-words">{head ? `${cardTitle(head)} · запрос № ${id}` : `Запрос № ${id}`}</span>}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden text-[13px] text-[var(--color-text)] md:overflow-hidden">
          {q.error && !d && (
            <div className="m-4 rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">
              {q.error.status === 404 || q.error.status === 403 ? 'Запрос не найден или недоступен вам.' : q.error.message}
            </div>
          )}
          {head && <Header c={head} d={d} queueName={queueName} />}
          {d && can && (
            <ActionBar d={d} busy={busy} onAction={k => {
              if (k === 'take') void act({ action: 'take' }, 'Запрос ваш — он в «В работе»');
              else if (k === 'answer') { setAnswering(true); setPane('offers'); }
              else setDialog({ kind: k } as Dialog);
            }} />
          )}
          {d && <div className="sticky top-0 z-10 bg-[var(--color-bg-overlay)] px-4 md:static"><TabsRibbon tabs={tabs} active={pane === 'chat' && !isMobile ? 'request' : pane} onChange={setPane} /></div>}

          {d && (
            <div className="flex min-w-0 flex-col md:grid md:min-h-0 md:flex-1 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] md:overflow-hidden">
              <div className={`${pane === 'chat' ? 'hidden md:flex' : 'flex'} min-w-0 flex-col gap-3 px-4 py-3 md:min-h-0 md:overflow-y-auto`}>
                {left === 'request' && <RequestPane d={d} onRewrite={d.deal && (d.roles.manager || d.roles.admin) && (d.dealRowsStatus === 'error' || d.dealRowsStatus === 'skipped') ? () => setDialog({ kind: 'rewrite' }) : undefined} />}
                {left === 'offers' && (
                  <div className="flex min-w-0 flex-col gap-3">
                    {can?.answer && !answering && (
                      <button type="button" onClick={() => setAnswering(true)} className={`${BTN_PRIMARY} self-start`}>+ Новый вариант</button>
                    )}
                    {answering && (
                      <OfferForm details={d} busy={busy} onCancel={() => setAnswering(false)}
                        onSubmit={async offer => { if (await act({ action: 'answer', offer }, 'Вариант отправлен менеджеру')) setAnswering(false); }} />
                    )}
                    {d.offers.length === 0 && !answering && <p className="text-sm text-[var(--color-text-muted)]">Вариантов пока нет.</p>}
                    {[...d.offers].sort((a, b) => b.n - a.n).map(o => (
                      <OfferCard key={o.id} offer={o} details={d} busy={busy}
                        canAccept={!!can?.accept} canWithdraw={!!can?.withdraw_offer}
                        onAccept={offer => setDialog({ kind: 'accept', offer })} onWithdraw={offer => setDialog({ kind: 'withdraw', offer })} />
                    ))}
                  </div>
                )}
                {left === 'history' && <HistoryPane d={d} queueName={queueName} offerN={offerN} />}
              </div>
              <div className={`${pane === 'chat' ? 'flex' : 'hidden md:flex'} h-[70dvh] min-w-0 flex-col md:h-auto border-[var(--color-border)] px-4 py-3 md:min-h-0 md:border-l`}>
                <RequestChat messages={d.messages} events={d.events} me={me} canPost={!!can?.message} busy={busy}
                  onSend={sendMessage} queueName={queueName} offerN={offerN} />
              </div>
            </div>
          )}
          {!d && !q.error && <div className="p-4 text-sm text-[var(--color-text-muted)]">Загружаю запрос…</div>}
        </div>
      </Modal>

      {d && dialog && <ActionDialog d={d} dialog={dialog} queues={queues} busy={busy} onClose={() => setDialog(null)} act={act} />}

      {toast && (
        <div role={toast.bad ? 'alert' : 'status'}
          className={`fixed bottom-4 left-1/2 z-[60] w-max max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg px-4 py-3 text-sm text-white shadow-lg ${toast.bad ? 'bg-[var(--color-negative)]' : 'bg-[var(--color-positive)]'}`}>
          {toast.text}
        </div>
      )}
    </>
  );
}

// ── шапка ───────────────────────────────────────────────────────────────────────────────

function Header({ c, d, queueName }: { c: RequestCard; d: RequestDetails | undefined; queueName: (id: number) => string | null }) {
  const sla = slaText(c.sla);
  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-2 border-b border-[var(--color-border)] px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="text-[17px] font-bold tabular-nums">{money(c.amount)}</span>
        <span className={`rounded px-1.5 py-0.5 text-[12px] font-semibold ${TYPE_META[c.type].cls}`}>{REQUEST_TYPE_LABEL[c.type]}</span>
        <span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${STATUS_CLS[c.status]}`}>{REQUEST_STATUS_LABEL[c.status]}</span>
        {c.cycle > 1 && <span className="text-[12px] text-[var(--color-negative)]">цикл {c.cycle} · возвратов {c.returnsCount}</span>}
        {sla && <span className={`text-[12px] ${SLA_CLS[c.sla.state]}`} title={c.sla.deadline ? `Крайний срок ${fmtDT(c.sla.deadline)} (норма ${c.sla.hours} раб. ч)` : undefined}>SLA: {sla}</span>}
        {c.dealOutcome && <span className={`text-[12px] font-semibold ${c.dealOutcome === 'sold' ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>{c.dealOutcome === 'sold' ? 'сделка продана' : 'сделка забракована'}</span>}
      </div>
      {c.priority.score > 0 && (
        <div className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] ${c.priority.hot ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-muted)]'}`}>
          <span className="inline-flex items-center gap-0.5 font-semibold"><Flame size={13} aria-hidden />приоритет {Math.round(c.priority.score)}</span>
          {c.priority.reasons.map(r => <span key={r}>· {r}</span>)}
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[var(--color-text-secondary)]">
        <span>Менеджер: <b className="text-[var(--color-text)]">{c.manager.name ?? '—'}</b></span>
        <span>Логист: <b className={c.logist ? 'text-[var(--color-text)]' : 'italic text-[var(--color-text-muted)]'}>{c.logist?.name ?? 'не взят'}</b></span>
        {c.queue && <span className="min-w-0 truncate">Очередь: {queueName(c.queue.id) ?? c.queue.name}</span>}
        <span>Отправлен: {fmtDT(c.sentAt)}</span>
        {d?.watchers.length ? <span>Наблюдатели: {d.watchers.map(w => w.name ?? w.bitrixId).join(', ')}</span> : null}
        <span className="flex flex-wrap gap-1.5 sm:ml-auto">
          {c.deal && <a href={c.deal.url} target="_blank" rel="noreferrer" className={linkBtn} title="Сделка в Битриксе"><ExternalLink size={12} /> Сделка № {c.deal.id}</a>}
          {c.bxTaskId && (
            <a href={`https://td.monolit-crm.ru/company/personal/user/0/tasks/task/view/${c.bxTaskId}/`} target="_blank" rel="noreferrer" className={linkBtn}
              title={c.bxSyncStatus === 'error' ? `Дубль-задача: ошибка синхронизации${d?.bxSyncError ? ` — ${d.bxSyncError}` : ''}` : 'Дубль-задача в Битриксе'}>
              <ExternalLink size={12} /> Задача № {c.bxTaskId}{c.bxSyncStatus === 'error' ? ' ⚠' : ''}
            </a>
          )}
        </span>
      </div>
    </div>
  );
}

// ── кнопки действий ─────────────────────────────────────────────────────────────────────

type BarAction = 'send' | 'take' | 'answer' | 'release' | 'transfer' | 'reassign' | 'return' | 'add_items' | 'cancel';

function ActionBar({ d, busy, onAction }: { d: RequestDetails; busy: boolean; onAction: (k: BarAction) => void }) {
  const can = d.can;
  const primary: { k: BarAction; label: string }[] = [];
  const secondary: { k: BarAction; label: string; danger?: boolean }[] = [];
  if (can.send) primary.push({ k: 'send', label: 'Отправить логисту' });
  if (can.take) primary.push({ k: 'take', label: 'Взять' });
  if (can.answer) primary.push({ k: 'answer', label: d.offers.some(o => o.status === 'active') ? 'Ещё вариант' : 'Ответить вариантом' });
  if (can.return) secondary.push({ k: 'return', label: 'Вернуть на доработку' });
  if (can.release) secondary.push({ k: 'release', label: 'Отпустить' });
  if (can.transfer) secondary.push({ k: 'transfer', label: 'Передать в очередь' });
  if (can.reassign) secondary.push({ k: 'reassign', label: 'Переназначить' });
  if (can.add_items) secondary.push({ k: 'add_items', label: 'Добавить позиции' });
  if (can.cancel) secondary.push({ k: 'cancel', label: 'Отменить запрос', danger: true });
  const hint = d.status === 'answered' && can.accept ? 'Посмотрите варианты: примите подходящий или верните на доработку.'
    : d.status === 'draft' ? 'Черновик видите только вы. Отправьте — запрос уйдёт в очередь логистов.' : null;
  if (!primary.length && !secondary.length && !hint) return null;
  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-1.5 border-b border-[var(--color-border)] px-4 py-2">
      {hint && <p className="text-[12px] text-[var(--color-text-secondary)]">{hint}</p>}
      {d.status === 'draft' && can.update_draft && (
        <Link href={`/logist-requests/${d.id}`} className="self-start text-[12.5px] text-[var(--color-accent)] underline">Заполнить черновик в форме запроса →</Link>
      )}
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {primary.map(a => <button key={a.k} type="button" disabled={busy} onClick={() => onAction(a.k)} className={BTN_PRIMARY}>{a.label}</button>)}
        {secondary.map(a => <button key={a.k} type="button" disabled={busy} onClick={() => onAction(a.k)} className={a.danger ? BTN_DANGER : BTN_PLAIN}>{a.label}</button>)}
      </div>
    </div>
  );
}

// ── вкладка «Запрос» ────────────────────────────────────────────────────────────────────

function RequestPane({ d, onRewrite }: { d: RequestDetails; onRewrite?: () => void }) {
  const cheaper = d.type === 'cheaper';
  const facts: [string, string | null][] = [
    ['Заказчик', d.client.name], ['Адрес', d.address], ['Для каких целей', d.purpose], ['Форма оплаты', d.paymentForm],
    ['Дата поставки', d.deliveryDate ? fmtDate(d.deliveryDate) : null],
    ['Конкурент', cheaper ? d.competitorName : null],
    ['Товарные группы', d.productGroups.join(', ') || null],
  ];
  return (
    <>
      <Section title="Шапка">
        <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {facts.filter(([, v]) => v).map(([k, v]) => (
            <div key={k} className="min-w-0"><dt className="text-[11px] text-[var(--color-text-muted)]">{k}</dt><dd className="break-words">{v}</dd></div>
          ))}
        </dl>
        {d.comment && <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-[var(--color-bg)] p-2 text-[12.5px]">{d.comment}</p>}
        {d.cancelReason && <p className="mt-2 text-[12.5px] text-[var(--color-negative)]">Причина отмены: {d.cancelReason}</p>}
        {d.dealRowsStatus !== 'none' && (
          <p className={`mt-2 text-[12px] ${d.dealRowsStatus === 'error' ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`}>
            Товары сделки: {d.dealRowsStatus === 'ok' ? 'переписаны по принятому варианту' : d.dealRowsStatus === 'pending' ? 'переписываются…' : d.dealRowsStatus === 'skipped' ? 'не переписывались' : `ошибка — ${d.dealRowsError ?? 'см. журнал'}`}
            {onRewrite && <button type="button" onClick={onRewrite} className="ml-2 min-h-11 rounded-lg border border-[var(--color-border)] px-3 text-[12px] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] sm:min-h-8">Переписать товары сделки</button>}
          </p>
        )}
      </Section>
      <Section title={`Позиции (${d.items.length})`}>
        <div className="scroll-x">
          <table className="w-full min-w-[480px] text-[12.5px]">
            <thead className="text-left text-[11px] text-[var(--color-text-muted)]">
              <tr>
                <th className="py-1 pr-2 font-medium">Товар</th>
                <th className="py-1 pr-2 text-right font-medium">Кол-во</th>
                <th className="py-1 pr-2 text-right font-medium">Наша цена</th>
                <th className="py-1 pr-2 text-right font-medium">Сумма</th>
                {cheaper && <th className="py-1 text-right font-medium">Конкурент</th>}
              </tr>
            </thead>
            <tbody>
              {d.items.map(i => (
                <tr key={i.id} className="border-t border-[var(--color-border)] align-top">
                  <td className="py-1 pr-2">
                    <div className="break-words">{i.name}</div>
                    {(i.kind === 'free' || i.comment || i.addedInCycle > 1) && (
                      <div className="text-[11px] text-[var(--color-text-muted)]">
                        {[i.kind === 'free' && 'нет в 1С', i.addedInCycle > 1 && `добавлена в цикле ${i.addedInCycle}`, i.comment].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{qty(i.quantity)} {i.measure ?? ''}</td>
                  <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{money(i.ourPrice)}</td>
                  <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{money(i.ourSum)}</td>
                  {cheaper && <td className="whitespace-nowrap py-1 text-right tabular-nums text-[var(--color-warning)]">{money(i.competitorPrice)}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-[var(--color-border)] font-semibold">
                <td className="py-1 pr-2">Итого</td><td /><td />
                <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{money(d.ourTotal)}</td>
                {cheaper && <td className="whitespace-nowrap py-1 text-right tabular-nums text-[var(--color-warning)]">{money(d.competitorTotal)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      </Section>
    </>
  );
}

// ── вкладка «История» ───────────────────────────────────────────────────────────────────

function HistoryPane({ d, queueName, offerN }: { d: RequestDetails; queueName: (id: number) => string | null; offerN: (id: number) => number | null }) {
  return (
    <>
      {d.cycles.length > 0 && (
        <Section title="Циклы (рабочие часы 9–18 МСК)">
          <div className="scroll-x">
            <table className="w-full min-w-[460px] text-[12.5px]">
              <thead className="text-left text-[11px] text-[var(--color-text-muted)]">
                <tr><th className="py-1 pr-2 font-medium">№</th><th className="py-1 pr-2 font-medium">Старт</th><th className="py-1 pr-2 text-right font-medium">До взятия</th><th className="py-1 pr-2 text-right font-medium">Взятие → ответ</th><th className="py-1 pr-2 text-right font-medium">До ответа</th><th className="py-1 font-medium">Ответил</th></tr>
              </thead>
              <tbody>
                {d.cycles.map(c => (
                  <tr key={c.n} className="border-t border-[var(--color-border)]">
                    <td className="py-1 pr-2 tabular-nums">{c.n}</td>
                    <td className="whitespace-nowrap py-1 pr-2">{fmtDT(c.start)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{hours(c.takeH)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{hours(c.execH)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{hours(c.answerH)}</td>
                    <td className="py-1">{c.by?.name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      <Section title="Журнал">
        <ol className="flex min-w-0 flex-col gap-1">
          {[...d.events].reverse().filter(e => e.kind !== 'message').map(e => (
            <li key={e.id} className="flex min-w-0 gap-2 text-[12.5px]">
              <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtDT(e.at)}</span>
              <span className="min-w-0 break-words">{eventText(e, queueName, offerN)}</span>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}

// ── диалоги действий ────────────────────────────────────────────────────────────────────

function ActionDialog({ d, dialog, queues, busy, onClose, act }: {
  d: RequestDetails; dialog: Dialog; queues: QueueRef[]; busy: boolean; onClose: () => void;
  act: (b: ActionBody, ok?: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [pick, setPick] = useState('');
  const run = async (b: ActionBody, ok: string) => { if (await act(b, ok)) onClose(); };

  if (dialog.kind === 'accept') {
    const o = dialog.offer;
    // dealRows — подтверждение предпросмотра S4: без него товары сделки не переписываются (deal_rows_status='skipped').
    return (
      <AcceptOfferDialog d={d} offer={o} busy={busy} onCancel={onClose}
        onConfirm={hash => void run({ action: 'accept', offerId: o.id, ...(hash ? { dealRows: { confirm: true as const, hash } } : {}) }, 'Вариант принят')} />
    );
  }
  if (dialog.kind === 'rewrite') return <RewriteRowsDialog d={d} onClose={onClose} />;
  if (dialog.kind === 'withdraw') {
    return (
      <ConfirmDialog open onCancel={onClose} title={`Отозвать вариант № ${dialog.offer.n}?`} confirmLabel="Отозвать" tone="danger" pending={busy}
        onConfirm={() => void run({ action: 'withdraw_offer', offerId: dialog.offer.id }, 'Вариант отозван')}
        description="Менеджер больше не сможет его принять; в истории он останется зачёркнутым." />
    );
  }
  if (dialog.kind === 'send') {
    return (
      <ConfirmDialog open onCancel={onClose} title="Отправить запрос логисту?" confirmLabel="Отправить" pending={busy}
        onConfirm={() => void run({ action: 'send' }, 'Запрос в очереди логистов')}
        description={`Очередь: ${d.queue?.name ?? 'не выбрана'}. Позиций: ${d.items.length}.`} />
    );
  }
  if (dialog.kind === 'add_items') return <AddItemsDialog busy={busy} onClose={onClose} onSubmit={items => void run({ action: 'add_items', items }, 'Позиции добавлены')} />;
  if (dialog.kind === 'reassign') return <ReassignDialog d={d} busy={busy} onClose={onClose} run={run} />;

  const cfg = {
    return: { title: 'Вернуть на доработку', label: 'Что не так с вариантами (обязательно)', placeholder: 'Дорого — у конкурента 410 ₽; нужен срок до пятницы', btn: 'Вернуть', required: true },
    cancel: { title: 'Отменить запрос', label: 'Причина', placeholder: 'Заказчик передумал', btn: 'Отменить запрос', required: false },
    release: { title: 'Отпустить запрос в очередь', label: 'Комментарий', placeholder: 'Не моя группа товаров', btn: 'Отпустить', required: false },
    transfer: { title: 'Передать в другую очередь', label: 'Комментарий', placeholder: 'Это кровля, не стеновые', btn: 'Передать', required: false },
  }[dialog.kind];
  const queueOptions = queues.filter(x => x.id !== d.queue?.id).map(x => ({ value: String(x.id), label: x.name, hint: [x.region, x.dept].filter(Boolean).join(' · ') || null }));
  const ready = (!cfg.required || text.trim()) && (dialog.kind !== 'transfer' || pick);
  const submit = () => {
    const t = text.trim() || undefined;
    if (dialog.kind === 'return') void run({ action: 'return', comment: text.trim() }, 'Вернули логисту — новый цикл');
    else if (dialog.kind === 'cancel') void run({ action: 'cancel', reason: t }, 'Запрос отменён');
    else if (dialog.kind === 'release') void run({ action: 'release', comment: t }, 'Запрос снова в «Новых»');
    else void run({ action: 'transfer', queueId: Number(pick), comment: t }, 'Передан в другую очередь');
  };
  return (
    <Modal open onOpenChange={x => { if (!x) onClose(); }} title={cfg.title} desktopWidth="sm:max-w-md">
      <div className="flex min-w-0 flex-col gap-3">
        {dialog.kind === 'transfer' && (
          <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">Очередь
            <SearchSelect ariaLabel="Очередь" value={pick} onChange={setPick} options={queueOptions} placeholder="Выберите очередь" searchable
              searchPlaceholder="Поиск очереди" className="min-h-11 w-full min-w-0 justify-start rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm" />
          </label>
        )}
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">{cfg.label}
          <textarea value={text} onChange={e => setText(e.target.value)} rows={3} placeholder={cfg.placeholder} className={`${INPUT} py-2`} autoFocus />
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-3 text-sm hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy || !ready} onClick={submit}
            className={`min-h-11 rounded-lg px-4 text-sm font-medium text-white disabled:opacity-50 ${dialog.kind === 'cancel' ? 'bg-[var(--color-negative)]' : 'bg-[var(--color-accent)]'}`}>{cfg.btn}</button>
        </div>
      </div>
    </Modal>
  );
}

function ReassignDialog({ d, busy, onClose, run }: {
  d: RequestDetails; busy: boolean; onClose: () => void; run: (b: ActionBody, ok: string) => Promise<void>;
}) {
  const [pick, setPick] = useState('');
  const [text, setText] = useState('');
  const queues = useQuery<QueuesResponse>({ queryKey: ['logist-queues'], queryFn: () => lkFetch<QueuesResponse>('/api/logist-kanban/queues'), staleTime: 60_000 });
  const options = useMemo(() => {
    const own = queues.data?.queues.find(x => x.id === d.queue?.id)?.members ?? [];
    const all = new Map<string, { value: string; label: string; hint: string | null }>();
    for (const m of own) all.set(m.bitrixId, { value: m.bitrixId, label: m.name ?? `id ${m.bitrixId}`, hint: `эта очередь${m.workPosition ? ` · ${m.workPosition}` : ''}` });
    for (const q of queues.data?.queues ?? []) for (const m of q.members) if (!all.has(m.bitrixId)) all.set(m.bitrixId, { value: m.bitrixId, label: m.name ?? `id ${m.bitrixId}`, hint: q.name });
    return [...all.values()].filter(o => o.value !== d.logist?.bitrixId);
  }, [queues.data, d.queue?.id, d.logist?.bitrixId]);
  const name = options.find(o => o.value === pick)?.label ?? null;
  return (
    <Modal open onOpenChange={x => { if (!x) onClose(); }} title="Переназначить логиста" desktopWidth="sm:max-w-md">
      <div className="flex min-w-0 flex-col gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">Логист
          <SearchSelect ariaLabel="Логист" value={pick} onChange={setPick} options={options} searchable searchPlaceholder="Поиск логиста"
            placeholder={queues.isLoading ? 'Загружаю…' : 'Выберите логиста'} className="min-h-11 w-full min-w-0 justify-start rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm" />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">Комментарий
          <textarea value={text} onChange={e => setText(e.target.value)} rows={2} className={`${INPUT} py-2`} />
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-3 text-sm hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy || !pick} onClick={() => void run({ action: 'reassign', logistBitrixId: pick, logistName: name, comment: text.trim() || undefined }, `Запрос у ${name ?? 'логиста'}`)}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white disabled:opacity-50">Переназначить</button>
        </div>
      </div>
    </Modal>
  );
}

function AddItemsDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (items: ItemInput[]) => void }) {
  const [rows, setRows] = useState([{ name: '', quantity: '', measure: '', comment: '' }]);
  const patch = (i: number, p: Partial<(typeof rows)[number]>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const valid = rows.filter(r => r.name.trim());
  return (
    <Modal open onOpenChange={x => { if (!x) onClose(); }} title="Добавить позиции" desktopWidth="sm:max-w-lg">
      <div className="flex min-w-0 flex-col gap-3">
        {rows.map((r, i) => (
          <div key={i} className="grid min-w-0 grid-cols-2 gap-1.5 rounded-lg bg-[var(--color-bg-surface)] p-2 sm:grid-cols-[2fr_0.8fr_0.7fr]">
            <input value={r.name} onChange={e => patch(i, { name: e.target.value })} placeholder="Наименование" aria-label="Наименование" className={`${INPUT} col-span-2 sm:col-span-1`} />
            <input value={r.quantity} onChange={e => patch(i, { quantity: e.target.value })} placeholder="Кол-во" inputMode="decimal" aria-label="Количество" className={`${INPUT} tabular-nums`} />
            <input value={r.measure} onChange={e => patch(i, { measure: e.target.value })} placeholder="ед." aria-label="Единица" className={INPUT} />
            <input value={r.comment} onChange={e => patch(i, { comment: e.target.value })} placeholder="Комментарий" aria-label="Комментарий" className={`${INPUT} col-span-2 sm:col-span-3`} />
          </div>
        ))}
        <button type="button" onClick={() => setRows(rs => [...rs, { name: '', quantity: '', measure: '', comment: '' }])}
          className="min-h-11 self-start rounded-lg border border-dashed border-[var(--color-border)] px-3 text-sm hover:bg-[var(--color-bg-hover)]">+ Ещё позиция</button>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-3 text-sm hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy || !valid.length}
            onClick={() => onSubmit(valid.map(r => {
              const qn = Number(r.quantity.replace(',', '.'));
              return { kind: 'free', name: r.name.trim(), quantity: r.quantity.trim() && Number.isFinite(qn) ? qn : null, measure: r.measure.trim() || null, comment: r.comment.trim() || null };
            }))}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white disabled:opacity-50">Добавить {valid.length || ''}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Повтор записи товаров принятого варианта (S4: POST /request/:id/deal-rows { confirm, hash }). */
function RewriteRowsDialog({ d, onClose }: { d: RequestDetails; onClose: () => void }) {
  const qc = useQueryClient();
  const pv = usePreview(d, d.acceptedOfferId);
  const [state, setState] = useState<{ busy: boolean; msg: string | null; bad: boolean }>({ busy: false, msg: null, bad: false });
  const write = async () => {
    if (!pv.data) return;
    setState({ busy: true, msg: null, bad: false });
    try {
      const r = await lkFetch<{ status: string; error: string | null }>(`/api/logist-kanban/request/${d.id}/deal-rows`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, hash: pv.data.hash }) });
      await qc.invalidateQueries({ queryKey: ['logist-request', d.id] });
      setState({ busy: false, msg: r.status === 'ok' ? 'Товары сделки переписаны' : r.error ?? 'Не записалось', bad: r.status !== 'ok' });
    } catch (e) { setState({ busy: false, msg: e instanceof Error ? e.message : 'Не записалось', bad: true }); }
  };
  return (
    <Modal open onOpenChange={x => { if (!x) onClose(); }} title="Переписать товары сделки" desktopWidth="sm:max-w-lg">
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        {pv.isLoading && <p className="text-[var(--color-text-muted)]">Читаю товары сделки…</p>}
        {pv.isError && <p className="text-[var(--color-negative)]">{pv.error instanceof Error ? pv.error.message : 'Предпросмотр недоступен'}</p>}
        {pv.data && <PreviewBody p={pv.data} />}
        {pv.data && !pv.data.writeEnabled && <p className="text-[12px] text-[var(--color-text-muted)]">Запись товаров выключена{pv.data.blockedReason ? ` (${pv.data.blockedReason})` : ''}.</p>}
        {state.msg && <p role={state.bad ? 'alert' : 'status'} className={state.bad ? 'text-[var(--color-negative)]' : 'text-[var(--color-positive)]'}>{state.msg}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-3 text-sm hover:bg-[var(--color-bg-hover)]">Закрыть</button>
          <button type="button" disabled={state.busy || !pv.data?.writeEnabled} onClick={() => void write()}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white disabled:opacity-50">Переписать</button>
        </div>
      </div>
    </Modal>
  );
}
