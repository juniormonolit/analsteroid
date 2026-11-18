'use client';
// Открытая карточка задачи канбана больших чеков (BIG_DEALS_KANBAN_SPEC.md; встреча 11.11, РОП Осипов: «каждый
// день проваливаться в каждую сделку и задачу в Битриксе» — здесь описание, сделка, звонки, чат и действия
// в одном окне). Данные доски — из card; описание, товары сделки и чат — GET /api/big-deals-kanban/task/{id};
// действия — POST /api/big-deals-kanban/action (engine/actions.ts). Modal: на десктопе окно, на телефоне bottom-sheet.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, UserRound } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { CustomerCardLoader } from '@/features/customers/ui/CustomerCardLoader';
import { TaskCheckPanel, useTaskChecks } from '@/features/repeat-kanban/ui/TaskCheck';
import type { BigPerson, BigTaskCard } from '../engine/types';
import type { BigTaskDetails } from '../engine/taskDetails';
import { STATE_META, cardAmount, fmtDT, money } from './format';
import { TaskChat } from './TaskDrawerChat';
import { TaskActions } from './TaskDrawerActions';
import { Section } from './TaskDrawerShared';

export function TaskDrawer(props: { card: BigTaskCard; canManage: boolean; managers: BigPerson[]; onClose: () => void; onChanged: (card?: BigTaskCard) => void }) {
  const { card, canManage, managers, onClose, onChanged } = props;
  const [client, setClient] = useState(false);
  const details = useQuery<BigTaskDetails>({
    queryKey: ['big-deals-task', card.id],
    queryFn: async () => {
      const r = await fetch(`/api/big-deals-kanban/task/${card.id}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j as BigTaskDetails;
    },
    staleTime: 30_000,
  });
  const checks = useTaskChecks([card.id], canManage);
  const changed = (c?: BigTaskCard) => { void details.refetch(); onChanged(c); };
  const st = STATE_META[card.state];
  const amount = cardAmount(card);
  const d = details.data;
  const deal = card.deal;

  return (
    <>
    {/* Карточка клиента — свой оверлей; Radix-модалка блокирует клики вне себя, поэтому на это время прячем её. */}
    <Modal open={!client} onOpenChange={o => { if (!o && !client) onClose(); }} desktopWidth="sm:max-w-5xl sm:w-[94vw]"
      title={<span className="line-clamp-2 break-words">{card.title}</span>}>
      <div className="flex min-w-0 flex-col gap-4 text-[13px] text-[var(--color-text)]">
        {/* Шапка */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] font-medium uppercase text-[var(--color-text-muted)]">{card.groupShort}</span>
          <span className="rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 text-[12px]">{card.stageTitle}</span>
          <span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${st.cls}`}>{st.label}</span>
          {amount != null && <span className="font-semibold">{money(amount)}</span>}
          {card.stuck && <span className="rounded bg-[var(--color-negative-soft)] px-1.5 py-0.5 text-[12px] text-[var(--color-negative)]">{card.daysInColumn} дн. в колонке</span>}
          <span className="flex flex-wrap gap-2 sm:ml-auto">
            <a href={card.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 rounded-md border border-[var(--color-border)] px-3 text-xs hover:bg-[var(--color-bg-hover)]"><ExternalLink size={13} /> Задача</a>
            {deal && <a href={deal.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 rounded-md border border-[var(--color-border)] px-3 text-xs hover:bg-[var(--color-bg-hover)]"><ExternalLink size={13} /> Сделка</a>}
            {deal && (deal.contactId || deal.companyId) && (
              <button type="button" onClick={() => setClient(true)} className="inline-flex min-h-11 items-center gap-1 rounded-md border border-[var(--color-border)] px-3 text-xs hover:bg-[var(--color-bg-hover)]"><UserRound size={13} /> Карточка клиента</button>
            )}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--color-text-secondary)]">
          <span>Исполнитель: <b className="text-[var(--color-text)]">{card.responsible.name}</b></span>
          <span>Постановщик: {card.creator.name}</span>
          <span>Создана: {fmtDT(card.createdAt)}</span>
          {card.deadlineAt && <span>Срок: {fmtDT(card.deadlineAt)}</span>}
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Левая колонка: описание, сделка, связанные, звонки */}
          <div className="flex min-w-0 flex-col gap-4">
            <Section title="Описание задачи">
              {details.isLoading && <p className="text-[var(--color-text-muted)]">Загружаю из Битрикса…</p>}
              {details.error && <p className="text-[var(--color-negative)]">{(details.error as Error).message}</p>}
              {d && (d.fields.length ? (
                <dl className="grid grid-cols-1 gap-1.5">
                  {d.fields.map((f, i) => (
                    <div key={i} className="min-w-0">
                      <dt className="text-[11.5px] text-[var(--color-text-muted)]">{f.label}</dt>
                      <dd className="whitespace-pre-wrap break-words">{f.value || '—'}</dd>
                    </div>
                  ))}
                </dl>
              ) : <p className="whitespace-pre-wrap break-words">{d.description || 'Описания нет'}</p>)}
            </Section>

            {deal && (
              <Section title="Сделка">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>{deal.stageName}{deal.closed === 'won' ? ' · выиграна' : deal.closed === 'lost' ? ' · проиграна' : ''}</span>
                  <span className="font-semibold">{money(deal.amount)}</span>
                  {deal.assigned && <span>Менеджер: {deal.assigned.name}</span>}
                </div>
                {d?.productsChanged && (
                  <p className="mt-2 rounded bg-[var(--color-warning)]/15 px-2 py-1 text-[12px] text-[var(--color-warning)]">Товары в сделке отличаются от товаров в задаче</p>
                )}
                {d?.dealProducts && d.dealProducts.length > 0 && (
                  <div className="scroll-x mt-2">
                    <table className="w-full min-w-[420px] text-[12px]">
                      <thead><tr className="text-left text-[var(--color-text-muted)]"><th className="py-1 pr-2 font-normal">Товар</th><th className="py-1 pr-2 text-right font-normal">Кол-во</th><th className="py-1 pr-2 text-right font-normal">Цена</th><th className="py-1 text-right font-normal">Сумма</th></tr></thead>
                      <tbody>
                        {d.dealProducts.map((p, i) => (
                          <tr key={i} className="border-t border-[var(--color-border)]">
                            <td className="py-1 pr-2">{p.name}</td>
                            <td className="whitespace-nowrap py-1 pr-2 text-right">{p.qty} {p.unit ?? ''}</td>
                            <td className="whitespace-nowrap py-1 pr-2 text-right">{money(p.price)}</td>
                            <td className="whitespace-nowrap py-1 text-right">{money(p.sum)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {d && d.dealProducts?.length === 0 && <p className="mt-1 text-[var(--color-text-muted)]">В сделке нет товаров</p>}
              </Section>
            )}

            {card.related.length > 0 && (
              <Section title="Связанные задачи">
                <ul className="flex flex-col gap-1.5">
                  {card.related.map(r => (
                    <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-2">
                      <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 break-words text-[var(--color-accent)] hover:underline">{r.title}</a>
                      <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATE_META[r.state].cls}`}>{STATE_META[r.state].label}</span>
                      <span className="text-[11.5px] text-[var(--color-text-muted)]">{[r.groupName, r.responsible?.name].filter(Boolean).join(' · ')}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section title="Звонки после постановки">
              {card.calls ? (
                <p>{card.calls.total} звонков, из них разговоров {card.calls.talks} ({Math.round(card.calls.talkSeconds / 60)} мин){card.calls.lastAt ? ` · последний ${fmtDT(card.calls.lastAt)}` : ''}</p>
              ) : <p className="text-[var(--color-text-muted)]">Нет данных о звонках</p>}
              {canManage && <div className="mt-2"><TaskCheckPanel taskId={card.id} state={checks.data?.[String(card.id)]} /></div>}
            </Section>
          </div>

          {/* Правая колонка: чат и действия */}
          <div className="flex min-w-0 flex-col gap-4">
            {canManage && <TaskActions card={card} managers={managers} onChanged={changed} />}
            <TaskChat card={card} messages={d?.chat ?? null} loading={details.isLoading} onSent={changed} />
          </div>
        </div>
      </div>
    </Modal>
    {client && deal && (
      <CustomerCardLoader contactId={deal.contactId} companyId={deal.companyId} onClose={() => setClient(false)} />
    )}
    </>
  );
}
