'use client';
// Открытая карточка задачи канбана больших чеков (BIG_DEALS_KANBAN_SPEC.md; встреча 11.11, РОП Осипов: «каждый
// день проваливаться в каждую сделку и задачу в Битриксе» — здесь описание, сделка, звонки, чат и действия
// в одном окне). Данные доски — из card; описание, товары сделки и чат — GET /api/big-deals-kanban/task/{id};
// действия — POST /api/big-deals-kanban/action (engine/actions.ts). Modal: на десктопе окно, на телефоне bottom-sheet.
//
// Вкладки (собрание РОПов 18.11, заменили три колонки «всё на одном экране» — «глаза разбегаются»):
// Работа — сделка, товары, ИИ-оценка | действия сверху, чат снизу (телефон — действия и чат первыми);
// Звонки — все разговоры клиента расшифровкой (CallsTab); Задачи по сделке — с их чатом; Клиент — ClientSummaryPanel.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Clock, Copy, ExternalLink, Link2, Phone, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
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
import { BigTaskCardView } from './BigTaskCardView';
import { STATE_META, cardAmount, fmtDT, money } from './format';
import { TaskChat } from './TaskDrawerChat';
import { BbText } from './BbText';
import { TaskThread, ThreadComposer } from './TaskThread';
import { postBigAction } from './TaskDrawerShared';
import { CardNoteField } from './CardNote';
import { TaskBriefSection } from './TaskBrief';
import { TaskActions } from './TaskDrawerActions';
import { ParticipantsField } from './ParticipantsField';
import { mockClientRef, mockTaskDetails, seedMockClient } from './mockClient';

type Pane = 'work' | 'calls' | 'tasks' | 'client';

const linkBtn = 'inline-flex min-h-11 items-center gap-1 rounded-md border border-[var(--color-border)] px-3 text-xs hover:bg-[var(--color-bg-hover)] sm:min-h-8';


export function TaskDrawer(props: { card: BigTaskCard; canManage: boolean; managers: BigPerson[]; onClose: () => void; onChanged: (card?: BigTaskCard) => void; mock?: boolean;
  /** Когда смотрящий открывал карточку в прошлый раз — разделитель «новое» в лентах (индикатор «новое», 25.11). */
  lastSeenAt?: string | null;
}) {
  const { card, managers, onClose, onChanged, mock = false, lastSeenAt = null } = props;
  const qc = useQueryClient();
  const [fullClient, setFullClient] = useState<ClientCardTab | null>(null);
  const [pane, setPane] = useState<Pane>('work');
  // Телефон и планшет: внутри «Работы» — «Чат | Задача» (Fable 25.11), по умолчанию чат; две колонки — от 1024px.
  const [seg, setSeg] = useState<'chat' | 'task'>('chat');
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
  const askItems = (items: string[]) => {
    setInject({ text: `По звонкам не увидел — ответь, пожалуйста:\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}`, key: Date.now() });
    setSeg('chat');
  };
  const overdue = !!card.deadlineAt && card.state !== 'done' && Date.parse(card.deadlineAt) < Date.now();
  const relNew = !!lastSeenAt && card.related.some(r => r.changedAt && r.changedAt > lastSeenAt);

  // Вкладки (собрание РОПов 18.11 + Fable 25.11): «Задачи по сделке» → «Связанные» (короче, влезает в 375px), точка — новое.
  const tabs: { key: Pane; label: string; count?: number }[] = [
    { key: 'work', label: 'Работа' },
    { key: 'calls', label: 'Звонки' },
    { key: 'tasks', label: relNew ? 'Связанные •' : 'Связанные', count: card.related.length },
    { key: 'client', label: 'Клиент' },
  ];
  const segBtn = (on: boolean) => `min-h-10 flex-1 rounded-md text-[13px] font-medium ${on ? 'bg-[var(--color-bg-surface)] shadow-sm' : 'text-[var(--color-text-secondary)]'}`;

  return (
    <>
    {/* Слайд справа с приклеенной карточкой доски слева (владелец 25.11: «слайдом с приклеенной карточкой, как в
        повторных; хоть на 80% экрана»). Полная карточка клиента открывается поверх (z выше), слайд не прячется. */}
    <BigSlide card={card} onClose={onClose} blockEsc={fullClient !== null}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col text-[13px] text-[var(--color-text)]">
        {/* Шапка в две строки (Fable 25.11): что и на сколько, стадия, статус, срок | клиент, телефон, исполнитель; ссылки — в «⋯». */}
        <div className="flex min-w-0 flex-col gap-1.5 border-b border-[var(--color-border)] px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
            {amount != null && <span className="text-[17px] font-bold tabular-nums">{money(amount)}</span>}
            {card.productGroup && <span className="min-w-0 truncate font-semibold">{card.productGroup}</span>}
            {deal && <StageBadge deal={deal} taskId={card.id} mock={mock} />}
            <span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${st.cls}`} title={`Статус задачи · проект ${card.groupShort} · колонка «${card.stageTitle}»`}>{st.label}</span>
            {card.deadlineAt && (
              <span className={`inline-flex items-center gap-0.5 text-[12px] ${overdue ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-text-secondary)]'}`} title="Срок задачи">
                <Clock size={12} aria-hidden />{overdue ? 'просрочена: ' : 'срок '}{fmtDT(card.deadlineAt)}
              </span>
            )}
            <span className={`text-[12px] ${card.stuck ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`} title={`Колонка «${card.stageTitle}»`}>· {card.daysInColumn} дн. в колонке</span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[var(--color-text-secondary)]">
            {card.client && <span className="min-w-0 truncate">Клиент: <b className="font-medium text-[var(--color-text)]">{card.client}</b></span>}
            {d?.phone && <PhoneLink phone={d.phone} />}
            <span className="min-w-0 truncate">Исполнитель: <b className="font-medium text-[var(--color-text)]">{card.responsible.name}</b></span>
            {deal?.assigned && deal.assigned.id !== card.responsible.id && <span className="min-w-0 truncate">По сделке: {deal.assigned.name}</span>}
            <span className="ml-auto"><LinksMenu card={card} /></span>
          </div>
        </div>

        <div className="px-4"><TabsRibbon tabs={tabs} active={pane} onChange={setPane} /></div>

        <div className={`min-h-0 flex-1 overflow-x-hidden px-4 py-3 ${pane === 'work' ? 'overflow-y-auto lg:overflow-hidden' : 'overflow-y-auto'}`}>
          {/* Работа. Десктоп: слева «Задача» (свой скролл), справа действия и чат на всю высоту, ввод прижат к низу.
              Телефон и планшет (< 1024px): «Чат | Задача». Скрываем, не размонтируем: черновик чата не теряется. */}
          <div className={pane === 'work' ? 'flex min-w-0 flex-col gap-3 lg:grid lg:h-full lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-4' : 'hidden'}>
            <div className="flex rounded-lg bg-[var(--color-bg-hover)] p-1 lg:hidden" role="tablist" aria-label="Чат или задача">
              <button type="button" role="tab" aria-selected={seg === 'chat'} className={segBtn(seg === 'chat')} onClick={() => setSeg('chat')}>Чат</button>
              <button type="button" role="tab" aria-selected={seg === 'task'} className={segBtn(seg === 'task')} onClick={() => setSeg('task')}>Задача</button>
            </div>
            <div className={`${seg === 'task' ? 'flex' : 'hidden'} min-w-0 flex-col gap-3 lg:flex lg:min-h-0 lg:overflow-y-auto lg:pr-1`}>
              <TaskBriefSection brief={d?.brief} dealProducts={d?.dealProducts} dealAmount={deal?.amount ?? null}
                loading={details.isLoading} error={details.error ? (details.error as Error).message : null} />
              <CardNoteField card={card} canEdit={canManage} onSaved={c => onChanged(c)} mock={mock} />
              {canManage && !mock && (
                <TaskCheckPanel taskId={card.id} state={checks.data?.[String(card.id)]} labels={BIG_CHECK_LABELS} onAsk={askItems} failed={checks.isError} onRetry={() => void checks.refetch()} />
              )}
              {d && <ParticipantsField taskId={card.id} auditors={d.auditors ?? card.auditors} me={d.viewer?.id ?? null} canManage={canManage && card.state !== 'done'} onChanged={changed} />}
            </div>
            <div className={`${seg === 'chat' ? 'flex' : 'hidden'} min-w-0 flex-col gap-2 lg:flex lg:min-h-0`}>
              {canManage && <TaskActions card={card} managers={managers} onChanged={changed} questions={d?.questions} mock={mock} />}
              <TaskChat card={card} messages={d?.chat ?? null} loading={details.isLoading} onSent={changed} questions={d?.questions}
                rop={d?.rop ?? null} inject={inject} me={d?.viewer?.id ?? null} lastSeenAt={lastSeenAt} mock={mock}
                className="h-[70dvh] lg:h-auto lg:min-h-0 lg:flex-1" />
            </div>
          </div>

          {pane === 'calls' && (hasClient
            ? <CallsTab taskId={card.id} contactId={ref.contactId} companyId={ref.companyId} mock={mock} />
            : <p className="text-[var(--color-text-muted)]">У задачи нет сделки с клиентом — звонков не найти.</p>)}

          {pane === 'tasks' && <RelatedTasks card={card} me={d?.viewer?.id ?? null} lastSeenAt={lastSeenAt} mock={mock} />}

          {pane === 'client' && (deal || hasClient ? (
            <ClientSummaryPanel contactId={ref.companyId ? null : ref.contactId} companyId={ref.companyId}
              fallbackName={card.client ?? null} enabled
              onOpenFull={hasClient ? tab => setFullClient(tab ?? 'overview') : undefined} />
          ) : (
            <p className="text-[var(--color-text-muted)]">{card.client ? `${card.client} — ` : ''}сделки нет, карточку клиента не открыть.</p>
          ))}
        </div>
      </div>
    </BigSlide>
    {fullClient !== null && hasClient && (
      <CustomerCardLoader contactId={ref.contactId} companyId={ref.companyId} initialTab={fullClient} zIndex={70} onClose={() => setFullClient(null)} />
    )}
    </>
  );
}

/** Панель справа на 80% ширины (телефон — во весь экран) + затемнённая полоса слева: клик — закрыть, в ней — карточка
 *  с доски, «приклеенная» сверху (как ClientCardDrawer повторных), когда полоса шире карточки (от 1280px). Esc — закрыть,
 *  если поверх не открыто своё окно (формы действий, подтверждения — Radix role=dialog). */
function BigSlide({ card, onClose, blockEsc, children }: { card: BigTaskCard; onClose: () => void; blockEsc: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || blockEsc) return;
      if (document.querySelector('[role="dialog"]:not([data-big-slide])')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, blockEsc]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex">
      <div className="relative hidden min-w-0 flex-1 cursor-pointer bg-black/40 sm:block" onClick={onClose}>
        <div className="pointer-events-none absolute right-3 top-3 hidden w-[min(18rem,calc(100%-24px))] min-[1280px]:block">
          <div className="pointer-events-auto cursor-default" onClick={e => e.stopPropagation()}>
            <BigTaskCardView card={card} onOpen={() => {}} />
          </div>
        </div>
      </div>
      <div role="dialog" aria-modal="true" aria-label={card.title} data-big-slide
        className="slide-panel-in-right relative flex h-dvh w-full max-w-full shrink-0 flex-col overflow-hidden bg-[var(--color-bg)] shadow-2xl sm:w-[80vw] sm:min-w-[min(100vw,720px)]">
        <div className="flex min-w-0 items-start gap-2 border-b border-[var(--color-border)] px-4 py-2.5">
          <h2 className="line-clamp-2 min-w-0 flex-1 break-words text-[15px] font-semibold">{card.title}</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть"
            className="tap-target flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
            <X size={18} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Задачи по той же сделке (логист, снабжение…): статус, описание (как в Битриксе, с таблицами), переписка — та же лента,
 *  что у чата задачи, и ответ прямо отсюда (владелец 25.11: «везде возможность написать сообщение из канбана»). */
function RelatedTasks({ card, me, lastSeenAt, mock }: { card: BigTaskCard; me: string | null; lastSeenAt: string | null; mock: boolean }) {
  const [open, setOpen] = useState<number | null>(card.related.length === 1 ? card.related[0].id : null);
  // «Запрос логисту» (канбан запросов логистам, S2): та же форма, что в карточке сделки
  const ask = card.deal ? <LogistRequestButton dealId={card.deal.id} mock={mock} className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-md border border-[var(--color-border)] px-3 text-[12.5px] font-medium hover:bg-[var(--color-bg-hover)]" /> : null;
  if (!card.related.length) return <div className="flex min-w-0 flex-col gap-2">{ask}<p className="text-[var(--color-text-muted)]">Других задач по этой сделке (логист, снабжение) нет.</p></div>;
  return (
    <div className="flex min-w-0 flex-col gap-2">
    {ask}
    <ul className="flex min-w-0 flex-col gap-2">
      {card.related.map(r => {
        const isNew = !!lastSeenAt && !!r.changedAt && r.changedAt > lastSeenAt;
        return (
          <li key={r.id} className={`min-w-0 rounded-lg border ${isNew ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
            <div className="flex min-w-0 items-stretch">
              <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}
                className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-bg-hover)]">
                {isNew && <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent)]" title="Новое с прошлого раза" />}
                <span className="min-w-0 flex-1 break-words font-medium">{r.title}</span>
                <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATE_META[r.state].cls}`}>{STATE_META[r.state].label}</span>
                <span className="text-[11.5px] text-[var(--color-text-muted)]">{[r.groupName, r.responsible?.name, r.changedAt ? `изм. ${fmtDT(r.changedAt)}` : null].filter(Boolean).join(' · ')}</span>
                <ChevronDown size={14} className={`shrink-0 transition-transform ${open === r.id ? 'rotate-180' : ''}`} aria-hidden />
              </button>
              <a href={r.url} target="_blank" rel="noreferrer" title="Задача в Битриксе" aria-label="Задача в Битриксе"
                className="flex w-11 shrink-0 items-center justify-center border-l border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]">
                <ExternalLink size={14} />
              </a>
            </div>
            {open === r.id && <RelatedChat taskId={card.id} rel={r} me={me} lastSeenAt={lastSeenAt} mock={mock} />}
          </li>
        );
      })}
    </ul>
    </div>
  );
}

const MOCK_REL_DESC = '[B]Менеджер:[/B] Игорь Гаврилов\n[B]Форма оплаты:[/B] Нал\n\n[B]Продукция из товаров:[/B]\n[TABLE][TR][TD][B]Товар[/B][/TD][TD][B]Кол-во[/B][/TD][TD][B]Наша цена[/B][/TD][TD][B]Цена конкурента[/B][/TD][/TR][TR][TD]Газобетон СК D400[/TD][TD]58.5 м3[/TD][TD]5100 руб[/TD][TD]4900 руб[/TD][/TR][/TABLE]\n\n[B]Комментарий:[/B] есть дешевле. 1 сорт';

function RelatedChat({ taskId, rel, me, lastSeenAt, mock }: { taskId: number; rel: BigRelatedTask; me: string | null; lastSeenAt: string | null; mock: boolean }) {
  const [desc, setDesc] = useState(false);
  const [mockSent, setMockSent] = useState<BigChatMessage[]>([]);
  const q = useQuery<{ chat: BigChatMessage[] | null; description: string; descriptionBb?: string }>({
    queryKey: ['big-deals-related', taskId, rel.id],
    queryFn: async () => {
      if (mock) return { chat: [{ id: 1, authorId: '1', author: 'Логист', at: new Date(Date.now() - 3600_000).toISOString(), text: 'Доставка 2 машинами, 48 000 ₽. Транзит дешевле на 6 000. Цены: https://docs.google.com/spreadsheets/d/1ZCvUIK1avLn4LhfBa/edit', system: false } as BigChatMessage], description: '', descriptionBb: MOCK_REL_DESC };
      const r = await fetch(`/api/big-deals-kanban/task/${taskId}/related?rel=${rel.id}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j;
    },
    staleTime: 60_000,
  });
  const bb = q.data?.descriptionBb || q.data?.description || '';
  const chat = q.data?.chat ? [...q.data.chat, ...mockSent] : null;
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-[var(--color-border)] px-3 py-2">
      {q.error && <p className="text-[var(--color-negative)]">{(q.error as Error).message}</p>}
      {bb && (
        <div className="min-w-0">
          <button type="button" onClick={() => setDesc(!desc)} aria-expanded={desc}
            className="inline-flex min-h-11 items-center gap-1 text-[12.5px] font-medium text-[var(--color-accent)] sm:min-h-8">
            <ChevronDown size={13} className={`transition-transform ${desc ? 'rotate-180' : ''}`} aria-hidden /> Описание задачи
          </button>
          {desc && <div className="mt-1 rounded-md bg-[var(--color-bg-hover)] px-3 py-2"><BbText text={bb} /></div>}
        </div>
      )}
      <TaskThread messages={chat} viewerId={me} roles={rel.responsible ? { [rel.responsible.id]: 'исполнитель' } : {}} lastSeenAt={lastSeenAt}
        loading={q.isLoading} emptyText="Сообщений пока нет" className="max-h-[50dvh]" />
      <ThreadComposer compact mock={mock} placeholder={`Сообщение в задачу${rel.responsible ? ` (${rel.responsible.name})` : ''} — от вашего имени`}
        mentions={rel.responsible ? [{ id: rel.responsible.id, name: rel.responsible.name, role: 'исполнитель' }] : []}
        onSend={async (text, attachments) => {
          if (mock) { setMockSent(m => [...m, { id: Date.now(), authorId: me ?? 'me', author: 'Вы', at: new Date().toISOString(), text, system: false }]); return; }
          const r = await postBigAction({ type: 'related_comment', taskId, relatedTaskId: rel.id, text, attachments });
          await q.refetch();
          return r.warnings;
        }} />
    </div>
  );
}

/** Ссылки — в «⋯» (Fable 25.11): Задача и Сделка в Битриксе, ссылка на карточку. */
function LinksMenu({ card }: { card: BigTaskCard }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const url = `${window.location.origin}/big-deals-kanban?task=${card.id}`;
    try { await navigator.clipboard.writeText(url); } catch { window.prompt('Скопируйте ссылку на карточку', url); return; }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  const item = 'flex min-h-11 w-full items-center gap-2 rounded px-2.5 text-left text-[13px] hover:bg-[var(--color-bg-hover)] sm:min-h-9';
  return (
    <Popover align="end" className="w-64 max-w-[calc(100vw-16px)] p-1"
      trigger={<button type="button" className={`${linkBtn} gap-1`} title="Ссылки"><Link2 size={13} /> Ссылки <ChevronDown size={12} /></button>}>
      <div className="flex flex-col">
        <button type="button" onClick={copy} className={item}>{copied ? <Check size={14} className="text-[var(--color-positive)]" /> : <Link2 size={14} />} {copied ? 'Скопировано' : 'Скопировать ссылку на карточку'}</button>
        <a href={card.url} target="_blank" rel="noreferrer" className={item}><ExternalLink size={14} /> Задача № {card.id} в Битриксе</a>
        {card.deal && <a href={card.deal.url} target="_blank" rel="noreferrer" className={item}><ExternalLink size={14} /> Сделка № {card.deal.id} в Битриксе</a>}
      </div>
    </Popover>
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
