'use client';
// Открытая карточка задачи канбана больших чеков (BIG_DEALS_KANBAN_SPEC.md; встреча 11.11, РОП Осипов: «каждый
// день проваливаться в каждую сделку и задачу в Битриксе» — здесь описание, сделка, звонки, чат и действия
// в одном окне). Данные доски — из card; описание, товары сделки и чат — GET /api/big-deals-kanban/task/{id};
// действия — POST /api/big-deals-kanban/action (engine/actions.ts). Modal: на десктопе окно, на телефоне bottom-sheet.
//
// Вкладки (собрание РОПов 18.11, заменили три колонки «всё на одном экране» — «глаза разбегаются»):
// Работа — сделка, товары, ИИ-оценка | действия сверху, чат снизу (телефон — действия и чат первыми);
// Звонки — все разговоры клиента расшифровкой (CallsTab); Задачи по сделке — с их чатом; Клиент — ClientSummaryPanel.
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Clock, Copy, ExternalLink, Link2, Phone } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { LogistRequestButton } from '@/features/logist-kanban/form/LogistRequestForm';
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
import type { BigPerson, BigRelatedTask, BigTaskCard } from '../engine/types';
import type { BigChatMessage, BigTaskDetails } from '../engine/taskDetails';
import { CallsTab } from './CallsTab';
import { StageBadge } from './StageHistory';
import { STATE_META, cardAmount, fmtDT, money } from './format';
import { ChatFileLink, TaskChat } from './TaskDrawerChat';
import { TaskActions } from './TaskDrawerActions';
import { Section } from './TaskDrawerShared';
import { ParticipantsField } from './ParticipantsField';
import { mockClientRef, mockTaskDetails, seedMockClient } from './mockClient';

type Pane = 'work' | 'calls' | 'tasks' | 'client';

const linkBtn = 'inline-flex min-h-11 items-center gap-1 rounded-md border border-[var(--color-border)] px-3 text-xs hover:bg-[var(--color-bg-hover)] sm:min-h-8';


export function TaskDrawer(props: { card: BigTaskCard; canManage: boolean; managers: BigPerson[]; onClose: () => void; onChanged: (card?: BigTaskCard) => void; mock?: boolean }) {
  const { card, managers, onClose, onChanged, mock = false } = props;
  const qc = useQueryClient();
  const [fullClient, setFullClient] = useState<ClientCardTab | null>(null);
  const [pane, setPane] = useState<Pane>('work');
  const [inject, setInject] = useState<{ text: string; key: number } | null>(null);
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
  const askItems = (items: string[]) => {
    setInject({ text: `По звонкам не увидел — ответь, пожалуйста:\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}`, key: Date.now() });
  };

  // Собрание РОПов 18.11: «минимизировать перескакивание, сделать вкладками»: Работа (сделка, ИИ-оценка | действия
  // сверху, чат снизу) · Звонки (расшифровки во всю ширину) · Задачи по сделке (логисты, снабжение — с их чатом) · Клиент.
  // Описание задачи убрано («точно не нужно — в задачу провалишься»), счётчик звонков — тоже (есть вкладка «Звонки»).
  const tabs: { key: Pane; label: string; count?: number }[] = [
    { key: 'work', label: 'Работа' },
    { key: 'calls', label: 'Звонки' },
    { key: 'tasks', label: 'Задачи по сделке', count: card.related.length },
    { key: 'client', label: 'Клиент' },
  ];

  return (
    <>
    {/* Полная карточка клиента — свой оверлей; Radix-модалка блокирует клики вне себя, поэтому на это время прячем её. */}
    <Modal open={fullClient === null} onOpenChange={o => { if (!o && fullClient === null) onClose(); }}
      desktopWidth="sm:max-w-[1400px] sm:w-[96vw]"
      contentClassName="flex h-[94dvh] max-h-[94dvh] flex-col overflow-hidden sm:h-[92vh] sm:max-h-[92vh]"
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
      title={<span className="line-clamp-2 break-words">{card.title}</span>}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col text-[13px] text-[var(--color-text)]">
        {/* Шапка: что и на сколько, стадия сделки (цветом, как в Битриксе), статус, кто. */}
        <div className="flex min-w-0 flex-col gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
            {amount != null && <span className="text-[17px] font-bold tabular-nums">{money(amount)}</span>}
            {card.productGroup && <span className="min-w-0 truncate font-semibold">{card.productGroup}</span>}
            {deal && <StageBadge deal={deal} taskId={card.id} mock={mock} />}
            <span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${st.cls}`} title="Статус задачи">{st.label}</span>
            <span className={`inline-flex items-center gap-0.5 text-[12px] ${card.stuck ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`} title={`Колонка «${card.stageTitle}»`}>
              <Clock size={12} aria-hidden />{card.daysInColumn} дн. в колонке
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[var(--color-text-secondary)]">
            <span>Исполнитель: <b className="text-[var(--color-text)]">{card.responsible.name}</b></span>
            {card.client && <span className="min-w-0 truncate">Клиент: {card.client}</span>}
            {deal?.createdAt && <span>Сделка создана: <b className="text-[var(--color-text)]">{fmtDT(deal.createdAt)}</b></span>}
            {card.deadlineAt && <span>Срок задачи: {fmtDT(card.deadlineAt)}</span>}
            <span className="rounded border border-[var(--color-border)] px-1 text-[10.5px] font-medium uppercase text-[var(--color-text-muted)]" title="Проект">{card.groupShort}</span>
            <span className="flex flex-wrap gap-1.5 sm:ml-auto">
              {d?.phone && <PhoneLink phone={d.phone} />}
              <a href={card.url} target="_blank" rel="noreferrer" className={linkBtn} title="Задача в Битриксе"><ExternalLink size={12} /> Задача № {card.id}</a>
              <CopyCardLink taskId={card.id} />
              {deal && <a href={deal.url} target="_blank" rel="noreferrer" className={linkBtn} title="Сделка в Битриксе"><ExternalLink size={12} /> Сделка № {deal.id}</a>}
            </span>
          </div>
        </div>

        <div className="px-4"><TabsRibbon tabs={tabs} active={pane} onChange={setPane} /></div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
          {/* Работа: слева сделка и ИИ-оценка, справа (на телефоне — первым) действия и чат. Скрываем, не размонтируем: черновик чата не теряется. */}
          <div className={pane === 'work' ? 'flex min-w-0 flex-col gap-3 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] md:items-start md:gap-4' : 'hidden'}>
            <div className="order-2 flex min-w-0 flex-col gap-3 md:order-1">
              {deal && (
                <Section title="Сделка и товары">
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <span className="font-semibold">{money(deal.amount)}</span>
                    {deal.assigned && <span>Ответственный: {deal.assigned.name}</span>}
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
                  {details.error && <p className="mt-1 text-[var(--color-negative)]">{(details.error as Error).message}</p>}
                  {d && d.dealProducts?.length === 0 && <p className="mt-1 text-[var(--color-text-muted)]">В сделке нет товаров</p>}
                </Section>
              )}
              {canManage && !mock && (
                <TaskCheckPanel taskId={card.id} state={checks.data?.[String(card.id)]} labels={BIG_CHECK_LABELS} onAsk={askItems} failed={checks.isError} onRetry={() => void checks.refetch()} />
              )}
              {card.related.length > 0 && (
                <button type="button" onClick={() => setPane('tasks')} className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-md border border-[var(--color-border)] px-3 text-[12.5px] hover:bg-[var(--color-bg-hover)]">
                  <Link2 size={13} aria-hidden /> Задачи по сделке: {card.related.length}{answered ? `, ответили ${answered}` : ''}
                </button>
              )}
              {d && <ParticipantsField taskId={card.id} auditors={d.auditors ?? card.auditors} me={d.viewer?.id ?? null} canManage={canManage && card.state !== 'done'} onChanged={changed} />}
            </div>
            <div className="order-1 flex min-w-0 flex-col gap-3 md:order-2">
              {canManage && <TaskActions card={card} managers={managers} onChanged={changed} questions={d?.questions} mock={mock} />}
              <TaskChat card={card} messages={d?.chat ?? null} loading={details.isLoading} onSent={changed} questions={d?.questions} rop={d?.rop ?? null} inject={inject} mock={mock} />
            </div>
          </div>

          {pane === 'calls' && (hasClient
            ? <CallsTab taskId={card.id} contactId={ref.contactId} companyId={ref.companyId} mock={mock} />
            : <p className="text-[var(--color-text-muted)]">У задачи нет сделки с клиентом — звонков не найти.</p>)}

          {pane === 'tasks' && <RelatedTasks card={card} mock={mock} />}

          {pane === 'client' && (deal || hasClient ? (
            <ClientSummaryPanel contactId={ref.companyId ? null : ref.contactId} companyId={ref.companyId}
              fallbackName={card.client ?? null} enabled
              onOpenFull={hasClient ? tab => setFullClient(tab ?? 'overview') : undefined} />
          ) : (
            <p className="text-[var(--color-text-muted)]">{card.client ? `${card.client} — ` : ''}сделки нет, карточку клиента не открыть.</p>
          ))}
        </div>
      </div>
    </Modal>
    {fullClient !== null && hasClient && (
      <CustomerCardLoader contactId={ref.contactId} companyId={ref.companyId} initialTab={fullClient} onClose={() => setFullClient(null)} />
    )}
    </>
  );
}

/** Задачи по той же сделке (логист, снабжение…): статус, по клику — их чат (только чтение). */
function RelatedTasks({ card, mock }: { card: BigTaskCard; mock: boolean }) {
  const [open, setOpen] = useState<number | null>(card.related.length === 1 ? card.related[0].id : null);
  // «Запрос логисту» (канбан запросов логистам, S2): та же форма, что в карточке сделки
  const ask = card.deal ? <LogistRequestButton dealId={card.deal.id} mock={mock} className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-md border border-[var(--color-border)] px-3 text-[12.5px] font-medium hover:bg-[var(--color-bg-hover)]" /> : null;
  if (!card.related.length) return <div className="flex min-w-0 flex-col gap-2">{ask}<p className="text-[var(--color-text-muted)]">Других задач по этой сделке (логист, снабжение) нет.</p></div>;
  return (
    <div className="flex min-w-0 flex-col gap-2">
    {ask}
    <ul className="flex min-w-0 flex-col gap-2">
      {card.related.map(r => (
        <li key={r.id} className="min-w-0 rounded-lg border border-[var(--color-border)]">
          <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}
            className="flex min-h-11 w-full min-w-0 flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-bg-hover)]">
            <span className="min-w-0 flex-1 break-words font-medium">{r.title}</span>
            <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATE_META[r.state].cls}`}>{STATE_META[r.state].label}</span>
            <span className="text-[11.5px] text-[var(--color-text-muted)]">{[r.groupName, r.responsible?.name, r.changedAt ? `изм. ${fmtDT(r.changedAt)}` : null].filter(Boolean).join(' · ')}</span>
            <ChevronDown size={14} className={`shrink-0 transition-transform ${open === r.id ? 'rotate-180' : ''}`} aria-hidden />
          </button>
          {open === r.id && <RelatedChat taskId={card.id} rel={r} mock={mock} />}
        </li>
      ))}
    </ul>
    </div>
  );
}

function RelatedChat({ taskId, rel, mock }: { taskId: number; rel: BigRelatedTask; mock: boolean }) {
  const q = useQuery<{ chat: BigChatMessage[] | null; description: string }>({
    queryKey: ['big-deals-related', taskId, rel.id],
    queryFn: async () => {
      if (mock) return { chat: [{ id: 1, authorId: '1', author: 'Логист', at: new Date().toISOString(), text: 'Доставка 2 машинами, 48 000 ₽. Транзит дешевле на 6 000.', system: false } as BigChatMessage], description: '' };
      const r = await fetch(`/api/big-deals-kanban/task/${taskId}/related?rel=${rel.id}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j;
    },
    staleTime: 60_000,
  });
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-[var(--color-border)] px-3 py-2">
      {q.isLoading && <p className="text-[var(--color-text-muted)]">Загружаю переписку…</p>}
      {q.error && <p className="text-[var(--color-negative)]">{(q.error as Error).message}</p>}
      {q.data && !q.data.chat?.filter(m => !m.system).length && (
        <p className="whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">{q.data.description || 'Сообщений нет'}</p>
      )}
      {q.data?.chat?.filter(m => !m.system).map(m => (
        <div key={m.id} className="min-w-0 rounded-lg bg-[var(--color-bg-hover)] px-2.5 py-1.5">
          <div className="text-[11px] text-[var(--color-text-muted)]">{m.author ?? m.authorId} · {fmtDT(m.at)}</div>
          {m.text && <div className="whitespace-pre-wrap break-words">{m.text}</div>}
          {m.files?.map((f, i) => <ChatFileLink key={i} file={f} />)}
        </div>
      ))}
      <a href={rel.url} target="_blank" rel="noreferrer" className={`${linkBtn} self-start`}><ExternalLink size={12} /> Открыть в Битриксе — ответить</a>
    </div>
  );
}

/** Телефон клиента сделки (РОП 18.11): звонок в один тап (tel:) и копирование. */
function PhoneLink({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(phone); } catch { window.prompt('Скопируйте телефон', phone); return; }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span className="inline-flex items-stretch">
      <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className={`${linkBtn} rounded-r-none font-medium text-[var(--color-text)]`} title="Позвонить клиенту">
        <Phone size={12} /> {phone}
      </a>
      <button type="button" onClick={copy} aria-label="Скопировать телефон" title="Скопировать телефон"
        className={`${linkBtn} -ml-px rounded-l-none px-2`}>
        {copied ? <Check size={13} className="text-[var(--color-positive)]" /> : <Copy size={13} />}
      </button>
    </span>
  );
}

/** Ссылка на эту карточку в Монолитике (Осипов 23.11: «надо копировать ссылку на карточку») — переслать в чат / себе. */
function CopyCardLink({ taskId }: { taskId: number }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const url = `${window.location.origin}/big-deals-kanban?task=${taskId}`;
    try { await navigator.clipboard.writeText(url); } catch { window.prompt('Скопируйте ссылку на карточку', url); return; }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" onClick={copy} className={linkBtn} title="Скопировать ссылку на эту карточку в Монолитике">
      {copied ? <Check size={12} className="text-[var(--color-positive)]" /> : <Link2 size={12} />} {copied ? 'Скопировано' : 'Ссылка на карточку'}
    </button>
  );
}
