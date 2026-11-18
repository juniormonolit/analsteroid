'use client';
// Открытая карточка задачи канбана больших чеков (BIG_DEALS_KANBAN_SPEC.md; встреча 11.11, РОП Осипов: «каждый
// день проваливаться в каждую сделку и задачу в Битриксе» — здесь описание, сделка, звонки, чат и действия
// в одном окне). Данные доски — из card; описание, товары сделки и чат — GET /api/big-deals-kanban/task/{id};
// действия — POST /api/big-deals-kanban/action (engine/actions.ts). Modal: на десктопе окно, на телефоне bottom-sheet.
//
// «Всё на одном экране» (владелец 18.11: «не нравится, что карточку клиента надо отдельно открывать»; план Fable):
// ≥1280 — три колонки: задача и сделка | действия, ИИ-проверка, чат | клиент (ClientSummaryPanel, без второго окна).
// 768–1279 — две колонки + вкладка «Клиент»; телефон — вкладки «Сводка · Чат · Клиент · Описание».
// Видимость колонок — чистым CSS по вкладке (без гидрации-ветвления); грузить клиента сразу — только на широком экране.
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, ExternalLink, Link2, Phone, PhoneOff } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { CustomerCardLoader } from '@/features/customers/ui/CustomerCardLoader';
import { ClientSummaryPanel } from '@/features/client-module/ui/ClientSummaryPanel';
import { TabsRibbon } from '@/features/client-module/ui/CardHeader';
import type { ClientCardTab } from '@/features/client-module/ui/ClientModuleWidget';
import { TaskCheckPanel, useTaskChecks, type TaskCheckLabels } from '@/features/repeat-kanban/ui/TaskCheck';

/** ИИ-оценка по чек-листу большой сделки (промпт bigDealCheckSystem, владелец 18.11). */
const BIG_CHECK_LABELS: TaskCheckLabels = {
  title: 'ИИ-оценка сделки',
  empty: 'По сделке нет звонков с расшифровкой (за 14 дней до задачи и после) — оценивать нечего.',
  run: 'Оценить звонки',
};
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import type { BigPerson, BigTaskCard } from '../engine/types';
import type { BigTaskDetails } from '../engine/taskDetails';
import { STATE_META, cardAmount, fmtDT, money, plural } from './format';
import { TaskChat } from './TaskDrawerChat';
import { TaskActions } from './TaskDrawerActions';
import { Section } from './TaskDrawerShared';
import { ParticipantsField } from './ParticipantsField';
import { mockClientRef, mockTaskDetails, seedMockClient } from './mockClient';

type Pane = 'summary' | 'chat' | 'client' | 'about';

const linkBtn = 'inline-flex min-h-11 items-center gap-1 rounded-md border border-[var(--color-border)] px-3 text-xs hover:bg-[var(--color-bg-hover)] sm:min-h-8';

export function TaskDrawer(props: { card: BigTaskCard; canManage: boolean; managers: BigPerson[]; onClose: () => void; onChanged: (card?: BigTaskCard) => void; mock?: boolean }) {
  const { card, managers, onClose, onChanged, mock = false } = props;
  const qc = useQueryClient();
  const [fullClient, setFullClient] = useState<ClientCardTab | null>(null);
  const [pane, setPane] = useState<Pane>('summary');
  const wide = useMediaQuery('(min-width: 1280px)');
  const [clientSeen, setClientSeen] = useState(false);
  const details = useQuery<BigTaskDetails>({
    queryKey: ['big-deals-task', card.id, mock ? 'mock' : ''],
    queryFn: async () => {
      if (mock) return mockTaskDetails(card);
      const r = await fetch(`/api/big-deals-kanban/task/${card.id}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j as BigTaskDetails;
    },
    staleTime: 30_000,
  });
  // Право управлять ЭТОЙ задачей — от сервера (visibility.ts); пока грузится — роль с доски.
  const canManage = props.canManage && (details.data?.viewer?.canManage ?? true);
  const checks = useTaskChecks([card.id], canManage && !mock);
  const changed = (c?: BigTaskCard) => { void details.refetch(); onChanged(c); };
  const st = STATE_META[card.state];
  const amount = cardAmount(card);
  const d = details.data;
  const deal = card.deal;
  const ref = mock ? mockClientRef(card) : { contactId: deal?.contactId ?? null, companyId: deal?.companyId ?? null };
  useMemo(() => { if (mock) seedMockClient(qc, card); }, [mock, qc, card]);
  const hasClient = !!(ref.contactId || ref.companyId);
  const answered = card.related.filter(r => r.state === 'control' || r.state === 'done').length;
  const goPane = (p: Pane) => { setPane(p); if (p === 'client') setClientSeen(true); };

  // Вкладки узкого экрана: на телефоне все четыре, на планшете «Сводка» = обе колонки задачи (Чат и Описание там же).
  const tabs: { key: Pane; label: string; count?: number }[] = [
    { key: 'summary', label: 'Задача' },
    { key: 'chat', label: 'Чат', count: d?.chat.filter(m => !m.system).length },
    { key: 'client', label: 'Клиент' },
    { key: 'about', label: 'Описание' },
  ];
  // Колонка видна: xl — всегда; md..xl — колонки задачи вместе (кроме вкладки «Клиент»), клиент — на своей вкладке;
  // телефон — только своя вкладка.
  const taskVisible = pane === 'client' ? 'hidden xl:flex' : pane === 'summary' || pane === 'about' ? 'flex' : 'hidden md:flex';
  const workVisible = pane === 'client' ? 'hidden xl:flex' : pane === 'chat' ? 'flex' : 'hidden md:flex';
  const clientVisible = pane === 'client' ? 'flex' : 'hidden xl:flex';
  const col = 'min-w-0 flex-col gap-3 xl:h-full xl:overflow-y-auto xl:overflow-x-hidden xl:pr-1';

  const about = (
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
      <p className="mt-2 text-[11.5px] text-[var(--color-text-muted)]">№ {card.id} · постановщик {card.creator.name} · создана {fmtDT(card.createdAt)}{card.deadlineAt ? ` · срок ${fmtDT(card.deadlineAt)}` : ''}</p>
    </Section>
  );

  return (
    <>
    {/* Полная карточка клиента — свой оверлей; Radix-модалка блокирует клики вне себя, поэтому на это время прячем её. */}
    <Modal open={fullClient === null} onOpenChange={o => { if (!o && fullClient === null) onClose(); }}
      desktopWidth="sm:max-w-[1560px] sm:w-[97vw]"
      contentClassName="flex h-[94dvh] max-h-[94dvh] flex-col overflow-hidden sm:h-[92vh] sm:max-h-[92vh]"
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
      title={<span className="line-clamp-2 break-words">{card.title}</span>}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col text-[13px] text-[var(--color-text)]">
        {/* Шапка: что и на сколько, статус, сколько стоит, кто — то, что РОП читает первым. */}
        <div className="flex min-w-0 flex-col gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
            {amount != null && <span className="text-[17px] font-bold tabular-nums">{money(amount)}</span>}
            {card.productGroup && <span className="min-w-0 truncate font-semibold">{card.productGroup}</span>}
            {deal && (
              <span className={`rounded px-1.5 py-0.5 text-[12px] ${deal.closed === 'won' ? 'bg-[var(--color-positive)]/15 font-semibold text-[var(--color-positive)]' : deal.closed === 'lost' ? 'bg-[var(--color-negative-soft)] font-semibold text-[var(--color-negative)]' : 'bg-[var(--color-bg-hover)]'}`}
                title="Стадия сделки">
                {deal.closed === 'won' ? 'сделка выиграна' : deal.closed === 'lost' ? 'сделка проиграна' : deal.stageName}
              </span>
            )}
            <span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${st.cls}`} title="Статус задачи">{st.label}</span>
            <span className={`inline-flex items-center gap-0.5 text-[12px] ${card.stuck ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`} title={`Колонка «${card.stageTitle}»`}>
              <Clock size={12} aria-hidden />{card.daysInColumn} дн. в колонке
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[var(--color-text-secondary)]">
            <span>Исполнитель: <b className="text-[var(--color-text)]">{card.responsible.name}</b></span>
            {card.client && <span className="min-w-0 truncate">Клиент: {card.client}</span>}
            <span className="rounded border border-[var(--color-border)] px-1 text-[10.5px] font-medium uppercase text-[var(--color-text-muted)]" title="Проект">{card.groupShort}</span>
            <span className="flex flex-wrap gap-1.5 sm:ml-auto">
              <a href={card.url} target="_blank" rel="noreferrer" className={linkBtn}><ExternalLink size={12} /> Задача</a>
              {deal && <a href={deal.url} target="_blank" rel="noreferrer" className={linkBtn}><ExternalLink size={12} /> Сделка</a>}
            </span>
          </div>
        </div>

        {/* Вкладки — только где колонки не помещаются (до 1280). */}
        <div className="px-4 xl:hidden">
          <div className="md:hidden"><TabsRibbon tabs={tabs} active={pane} onChange={goPane} /></div>
          <div className="hidden md:block">
            <TabsRibbon tabs={[{ key: 'summary' as Pane, label: 'Задача и чат' }, { key: 'client' as Pane, label: 'Клиент' }]}
              active={pane === 'client' ? 'client' : 'summary'} onChange={goPane} />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 md:grid md:grid-cols-2 md:gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(360px,420px)] xl:overflow-hidden">
          {/* Задача и сделка */}
          <div className={`${taskVisible} ${col}`}>
            {pane !== 'about' && <>
              {deal && (
                <Section title="Сделка и товары">
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
                      <table className="w-full min-w-[340px] text-[12px]">
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
                  {details.isLoading && <p className="mt-1 text-[var(--color-text-muted)]">Загружаю товары…</p>}
                  {d && d.dealProducts?.length === 0 && <p className="mt-1 text-[var(--color-text-muted)]">В сделке нет товаров</p>}
                </Section>
              )}

              <Section title="Звонки и ответы">
                <div className="flex flex-col gap-1.5">
                  {card.calls ? (card.calls.total > 0 ? (
                    <p className="inline-flex items-center gap-1.5"><Phone size={13} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
                      {card.calls.total} {plural(card.calls.total, 'звонок', 'звонка', 'звонков')} после постановки, разговоров {card.calls.talks} ({Math.round(card.calls.talkSeconds / 60)} мин){card.calls.lastAt ? ` · последний ${fmtDT(card.calls.lastAt)}` : ''}</p>
                  ) : (
                    <p className="inline-flex items-center gap-1.5 text-[var(--color-warning)]"><PhoneOff size={13} className="shrink-0" aria-hidden />После постановки по сделке не звонили</p>
                  )) : <p className="text-[var(--color-text-muted)]">Нет данных о звонках</p>}
                  {card.related.length > 0 ? (
                    <ul className="flex flex-col gap-1.5">
                      {card.related.map(r => (
                        <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-2">
                          <Link2 size={13} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
                          <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 break-words text-[var(--color-accent)] hover:underline">{r.title}</a>
                          <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATE_META[r.state].cls}`}>{STATE_META[r.state].label}</span>
                          <span className="text-[11.5px] text-[var(--color-text-muted)]">{[r.groupName, r.responsible?.name].filter(Boolean).join(' · ')}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="text-[var(--color-text-muted)]">Связанных задач (логист, снабжение) нет</p>}
                  {answered > 0 && <p className="text-[12px] text-[var(--color-positive)]">Ответили по {answered} из {card.related.length}</p>}
                </div>
              </Section>
            </>}
            {/* Описание: на телефоне — своя вкладка, на планшете и десктопе — внизу колонки задачи. */}
            <div className={pane === 'about' ? '' : 'hidden md:block'}>{about}</div>
          </div>

          {/* Работа: действия, ИИ-проверка, участники, чат */}
          <div className={`${workVisible} ${col}`}>
            {canManage && <TaskActions card={card} managers={managers} onChanged={changed} />}
            {canManage && !mock && (
              <TaskCheckPanel taskId={card.id} state={checks.data?.[String(card.id)]} labels={BIG_CHECK_LABELS} />
            )}
            <TaskChat card={card} messages={d?.chat ?? null} loading={details.isLoading} onSent={changed} />
            {d && <ParticipantsField taskId={card.id} auditors={d.auditors ?? card.auditors} me={d.viewer?.id ?? null} canManage={canManage && card.state !== 'done'} onChanged={changed} />}
          </div>

          {/* Клиент — на том же экране, без второго окна. */}
          <div className={`${clientVisible} ${col} md:col-span-2 xl:col-span-1 xl:border-l xl:border-[var(--color-border)] xl:pl-4`}>
            {deal || hasClient ? (
              <ClientSummaryPanel contactId={ref.companyId ? null : ref.contactId} companyId={ref.companyId}
                fallbackName={card.client ?? null} enabled={wide || clientSeen}
                onOpenFull={hasClient ? tab => setFullClient(tab ?? 'overview') : undefined} />
            ) : (
              <p className="text-[var(--color-text-muted)]">{card.client ? `${card.client} — ` : ''}сделки нет, карточку клиента не открыть.</p>
            )}
          </div>
        </div>
      </div>
    </Modal>
    {fullClient !== null && hasClient && (
      <CustomerCardLoader contactId={ref.contactId} companyId={ref.companyId} initialTab={fullClient} onClose={() => setFullClient(null)} />
    )}
    </>
  );
}
