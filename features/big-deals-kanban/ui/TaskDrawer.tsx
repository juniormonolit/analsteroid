'use client';
// Открытая карточка задачи канбана больших чеков (BIG_DEALS_KANBAN_SPEC.md; встреча 11.11, РОП Осипов: «каждый
// день проваливаться в каждую сделку и задачу в Битриксе» — здесь описание, сделка, звонки, чат и действия
// в одном окне). Данные доски — из card; описание, товары сделки и чат — GET /api/big-deals-kanban/task/{id};
// действия — POST /api/big-deals-kanban/action (engine/actions.ts). Modal: на десктопе окно, на телефоне bottom-sheet.
//
// Вкладки (собрание РОПов 18.11, заменили три колонки «всё на одном экране» — «глаза разбегаются»):
// Работа — сделка, товары, ИИ-оценка | действия сверху, чат снизу (телефон — действия и чат первыми);
// Звонки — все разговоры клиента расшифровкой (CallsTab); Задачи по сделке — с их чатом; Клиент — ClientSummaryPanel.
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { AiAnalysisTab, useAiAnalysisAccess } from '@/features/ai-analysis/ui/AiAnalysisTab';

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
import { BxLink, Section, postBigAction } from './TaskDrawerShared';
import { CardNoteField } from './CardNote';
import { TaskBriefSection } from './TaskBrief';
import { TaskActions } from './TaskDrawerActions';
import { ParticipantsField } from './ParticipantsField';
import { mockClientRef, mockTaskDetails, seedMockClient } from './mockClient';

type Pane = 'work' | 'calls' | 'client';

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
  // Какая задача открыта во вкладках справа (владелец 25.11: «справа всегда чат, сверху вкладки как в браузере:
  // задача БЧ / другие связанные»; слева — инфа и действия ЭТОЙ задачи).
  const [active, setActive] = useState<number | 'main'>('main');
  const rel = active === 'main' ? null : card.related.find(r => r.id === active) ?? null;
  const [relInject, setRelInject] = useState<{ text: string; key: number } | null>(null);
  const me = d?.viewer?.id ?? null;
  const portal = (() => { try { return new URL(card.url).origin; } catch { return null; } })();
  const clientUrl = portal && deal ? (deal.companyId ? `${portal}/crm/company/details/${deal.companyId}/` : deal.contactId ? `${portal}/crm/contact/details/${deal.contactId}/` : null) : null;

  // Вкладки (владелец 25.11): Работа · Звонки и ИИ (разговоры, ИИ-оценка сделки, ИИ-анализ клиента) · Клиент.
  // Связанные задачи — вкладками над чатом, не отдельной вкладкой.
  const tabs: { key: Pane; label: string; count?: number }[] = [
    { key: 'work', label: 'Работа' },
    { key: 'calls', label: 'Звонки и ИИ' },
    { key: 'client', label: 'Клиент' },
  ];
  const segBtn = (on: boolean) => `min-h-10 flex-1 rounded-md text-[13px] font-medium ${on ? 'bg-[var(--color-bg-surface)] shadow-sm' : 'text-[var(--color-text-secondary)]'}`;
  const strip = <TaskStrip card={card} active={active} onPick={setActive} lastSeenAt={lastSeenAt} mock={mock} />;

  return (
    <>
    {/* Слайд справа с приклеенной карточкой доски слева (владелец 25.11: «слайдом с приклеенной карточкой, как в
        повторных; хоть на 80% экрана»). Полная карточка клиента открывается поверх (z выше), слайд не прячется. */}
    <BigSlide card={card} onClose={onClose} blockEsc={fullClient !== null}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col text-[13px] text-[var(--color-text)]">
        {/* Шапка в две строки: что и на сколько, стадия, статус, срок | клиент, телефон, исполнитель; «Ссылки» — дубль ссылок по месту. */}
        <div className="flex min-w-0 flex-col gap-1.5 border-b border-[var(--color-border)] px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
            {amount != null && <span className="text-[17px] font-bold tabular-nums">{money(amount)}</span>}
            {card.productGroup && <span className="min-w-0 truncate font-semibold">{card.productGroup}</span>}
            {deal && <StageBadge deal={deal} taskId={card.id} mock={mock} />}
            {deal && <BxLink href={deal.url} title="Сделка в Битриксе">Сделка № {deal.id}</BxLink>}
            <span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${st.cls}`} title={`Статус задачи · проект ${card.groupShort} · колонка «${card.stageTitle}»`}>{st.label}</span>
            {card.deadlineAt && (
              <span className={`inline-flex items-center gap-0.5 text-[12px] ${overdue ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-text-secondary)]'}`} title="Срок задачи">
                <Clock size={12} aria-hidden />{overdue ? 'просрочена: ' : 'срок '}{fmtDT(card.deadlineAt)}
              </span>
            )}
            <span className={`text-[12px] ${card.stuck ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`} title={`Колонка «${card.stageTitle}»`}>· {card.daysInColumn} дн. в колонке</span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[var(--color-text-secondary)]">
            {card.client && (clientUrl
              ? <a href={clientUrl} target="_blank" rel="noreferrer" title="Клиент в Битриксе" className="min-w-0 truncate">Клиент: <b className="font-medium text-[var(--color-accent)]">{card.client} ↗</b></a>
              : <span className="min-w-0 truncate">Клиент: <b className="font-medium text-[var(--color-text)]">{card.client}</b></span>)}
            {d?.phone && <PhoneLink phone={d.phone} />}
            <span className="min-w-0 truncate">Исполнитель: <b className="font-medium text-[var(--color-text)]">{card.responsible.name}</b></span>
            {deal?.assigned && deal.assigned.id !== card.responsible.id && <span className="min-w-0 truncate">По сделке: {deal.assigned.name}</span>}
            <span className="ml-auto"><LinksMenu card={card} /></span>
          </div>
        </div>

        <div className="px-4"><TabsRibbon tabs={tabs} active={pane} onChange={setPane} /></div>

        <div className={`min-h-0 flex-1 overflow-x-hidden px-4 py-3 ${pane === 'work' ? 'overflow-y-auto lg:overflow-hidden' : 'overflow-y-auto'}`}>
          {/* Работа. Десктоп: слева действия, информация и комментарий ВЫБРАННОЙ задачи, справа вкладки задач и чат
              на всю высоту. Телефон и планшет (< 1024px): вкладки задач сверху + «Чат | Задача». Скрываем, не размонтируем. */}
          <div className={pane === 'work' ? 'flex min-w-0 flex-col gap-3 lg:grid lg:h-full lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-4' : 'hidden'}>
            <div className="min-w-0 lg:hidden">{strip}</div>
            <div className="flex rounded-lg bg-[var(--color-bg-hover)] p-1 lg:hidden" role="tablist" aria-label="Чат или задача">
              <button type="button" role="tab" aria-selected={seg === 'chat'} className={segBtn(seg === 'chat')} onClick={() => setSeg('chat')}>Чат</button>
              <button type="button" role="tab" aria-selected={seg === 'task'} className={segBtn(seg === 'task')} onClick={() => setSeg('task')}>Задача</button>
            </div>
            <div className={`${seg === 'task' ? 'flex' : 'hidden'} min-w-0 flex-col gap-3 lg:flex lg:min-h-0 lg:overflow-y-auto lg:pr-1`}>
              {rel && (
                <RelatedSide taskId={card.id} rel={rel} card={card} mock={mock}
                  onMention={() => { if (rel.responsible) { setRelInject({ text: `[USER=${rel.responsible.id}]${rel.responsible.name}[/USER], `, key: Date.now() }); setSeg('chat'); } }} />
              )}
              {/* Действия задачи БЧ при открытой связанной — скрыты, но смонтированы: черновик формы не теряется (ТЗ 26.11). */}
              <div className={rel ? 'hidden' : 'contents'}>
                {canManage && <TaskActions card={card} managers={managers} onChanged={changed} questions={d?.questions} mock={mock} />}
                <TaskBriefSection brief={d?.brief} dealProducts={d?.dealProducts} dealAmount={deal?.amount ?? null}
                  loading={details.isLoading} error={details.error ? (details.error as Error).message : null}
                  taskUrl={card.url} taskId={card.id} dealUrl={deal?.url ?? null} dealId={deal?.id ?? null} clientUrl={clientUrl} />
              </div>
              <CardNoteField card={card} canEdit={canManage} onSaved={c => onChanged(c)} mock={mock} />
              {!rel && d && <ParticipantsField taskId={card.id} auditors={d.auditors ?? card.auditors} me={me} canManage={canManage && card.state !== 'done'} onChanged={changed} />}
            </div>
            <div className={`${seg === 'chat' ? 'flex' : 'hidden'} min-w-0 flex-col gap-2 lg:flex lg:min-h-0`}>
              <div className="hidden min-w-0 lg:block">{strip}</div>
              {rel && (
                <RelatedChat key={rel.id} taskId={card.id} rel={rel} me={me} lastSeenAt={lastSeenAt} mock={mock} inject={relInject}
                  className="h-[70dvh] lg:h-auto lg:min-h-0 lg:flex-1" />
              )}
              {/* Чат задачи БЧ тоже не размонтируем — недописанное сообщение остаётся. */}
              <div className={rel ? 'hidden' : 'contents'}>
                <TaskChat card={card} messages={d?.chat ?? null} loading={details.isLoading} onSent={changed} questions={d?.questions}
                  rop={d?.rop ?? null} inject={inject} me={me} lastSeenAt={lastSeenAt} mock={mock} title={null}
                  className="h-[70dvh] lg:h-auto lg:min-h-0 lg:flex-1" />
              </div>
            </div>
          </div>

          {pane === 'calls' && (
            <CallsAndAi card={card} hasClient={hasClient} contactId={ref.contactId} companyId={ref.companyId} mock={mock}
              aiCheck={canManage && !mock ? (
                <TaskCheckPanel taskId={card.id} state={checks.data?.[String(card.id)]} labels={BIG_CHECK_LABELS} onAsk={items => { askItems(items); setActive('main'); setPane('work'); }} failed={checks.isError} onRetry={() => void checks.refetch()} />
              ) : null} />
          )}

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
          {/* Крестик крупный и контрастный (собрание 26.11: серый 18px в углу «не нашли»). */}
          <button type="button" onClick={onClose} aria-label="Закрыть" title="Закрыть (Esc). Черновики задач сохраняются"
            className="flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border-strong,var(--color-border))] bg-[var(--color-bg-surface)] px-3 text-[13px] font-semibold text-[var(--color-text)] shadow-sm hover:bg-[var(--color-bg-hover)]">
            <X size={20} strokeWidth={2.5} aria-hidden /><span className="hidden sm:inline">Закрыть</span>
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        {/* Телефон: второй крестик в зоне большого пальца — слева внизу, над полем ввода чата (отправка — справа). */}
        <button type="button" onClick={onClose} aria-label="Закрыть карточку"
          className="absolute bottom-[calc(env(safe-area-inset-bottom)+88px)] left-3 z-10 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-text)] text-[var(--color-bg)] shadow-lg sm:hidden">
          <X size={22} strokeWidth={2.5} />
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** Вкладки задач над чатом, как в браузере (владелец 25.11): «Задача БЧ» и связанные задачи по сделке (логист,
 *  снабжение) — точка = новое с прошлого открытия, ↗ — задача в Битриксе; в конце — «+ Запрос логисту».
 *  Лента по правилу 12 CLAUDE.md: min-w-0 у родителя, затухание у края, когда есть что листать, scrollbar-none,
 *  активная вкладка — в видимую область. */
function TaskStrip({ card, active, onPick, lastSeenAt, mock }: { card: BigTaskCard; active: number | 'main'; onPick: (k: number | 'main') => void; lastSeenAt: string | null; mock: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ l: false, r: false });
  const measure = () => { const el = box.current; if (!el) return; setFade({ l: el.scrollLeft > 2, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 }); };
  useEffect(() => { measure(); }, [card.related.length]);
  const first = useRef(true);
  useEffect(() => {
    const el = box.current?.querySelector(`[data-tab-key="${active}"]`) as HTMLElement | null;
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: first.current ? 'auto' : 'smooth' });
    first.current = false;
  }, [active]);
  const tab = (on: boolean) => `group relative flex min-h-11 shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 px-3 text-[12.5px] sm:min-h-9 ${on ? 'border-[var(--color-border)] bg-[var(--color-bg-surface)] font-semibold text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`;
  const ask = card.deal ? <LogistRequestButton dealId={card.deal.id} mock={mock} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2.5 text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] sm:min-h-9" /> : null;
  return (
    <div className="relative min-w-0 border-b border-[var(--color-border)]">
      <div ref={box} onScroll={measure} className="scrollbar-none flex min-w-0 items-end gap-0.5 overflow-x-auto" role="tablist" aria-label="Задачи по сделке">
        <div className={tab(active === 'main')} data-tab-key="main">
          <button type="button" role="tab" aria-selected={active === 'main'} onClick={() => onPick('main')} className="flex items-center gap-1.5">
            Задача БЧ <span className="font-normal text-[var(--color-text-muted)]">· {shortPerson(card.responsible.name)}</span>
          </button>
          <a href={card.url} target="_blank" rel="noreferrer" title="Эта задача в Битриксе" className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">↗</a>
        </div>
        {card.related.map(r => {
          const isNew = !!lastSeenAt && !!r.changedAt && r.changedAt > lastSeenAt;
          return (
            <div key={r.id} className={tab(active === r.id)} data-tab-key={r.id}>
              <button type="button" role="tab" aria-selected={active === r.id} onClick={() => onPick(r.id)} className="flex items-center gap-1.5" title={r.title}>
                {isNew && <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent)]" title="Новое с прошлого раза" />}
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.state === 'done' ? 'bg-[var(--color-positive)]' : r.state === 'control' ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-warning)]'}`} title={STATE_META[r.state].label} />
                {r.groupName ?? 'Связанная'} <span className="font-normal text-[var(--color-text-muted)]">· {r.responsible ? shortPerson(r.responsible.name) : '—'}</span>
              </button>
              <a href={r.url} target="_blank" rel="noreferrer" title="Задача в Битриксе" className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">↗</a>
            </div>
          );
        })}
        {ask}
      </div>
      {fade.l && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-[var(--color-bg)] to-transparent" />}
      {fade.r && <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-[var(--color-bg)] to-transparent" />}
    </div>
  );
}

const shortPerson = (n: string) => { const [a, b] = n.split(' '); return b ? `${a} ${b[0]}.` : a; };

const MOCK_REL_DESC = '[B]Менеджер:[/B] Игорь Гаврилов\n[B]Форма оплаты:[/B] Нал\n\n[B]Продукция из товаров:[/B]\n[TABLE][TR][TD][B]Товар[/B][/TD][TD][B]Кол-во[/B][/TD][TD][B]Наша цена[/B][/TD][TD][B]Цена конкурента[/B][/TD][/TR][TR][TD]Газобетон СК D400[/TD][TD]58.5 м3[/TD][TD]5100 руб[/TD][TD]4900 руб[/TD][/TR][/TABLE]\n\n[B]Комментарий:[/B] есть дешевле. 1 сорт';

type RelData = { chat: BigChatMessage[] | null; description: string; descriptionBb?: string };
/** Данные связанной задачи (переписка + описание) — общие для левой части и чата: один запрос на вкладку. */
function useRelated(taskId: number, rel: BigRelatedTask, mock: boolean) {
  return useQuery<RelData>({
    queryKey: ['big-deals-related', taskId, rel.id, mock],
    queryFn: async () => {
      if (mock) return { chat: [{ id: 1, authorId: '7', author: 'Логист', at: new Date(Date.now() - 3600_000).toISOString(), text: 'Доставка 2 машинами, 48 000 ₽. Транзит дешевле на 6 000. Цены: https://docs.google.com/spreadsheets/d/1ZCvUIK1avLn4LhfBa/edit', system: false }], description: '', descriptionBb: MOCK_REL_DESC };
      const r = await fetch(`/api/big-deals-kanban/task/${taskId}/related?rel=${rel.id}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j;
    },
    staleTime: 60_000,
  });
}

/** Левая часть, когда открыта связанная задача: свои действия (владелец 25.11: «кнопки — от того, какая задача открыта»)
 *  и её информация — описание как в Битриксе (таблица товаров, цена конкурента, комментарий). */
function RelatedSide({ taskId, rel, card, mock, onMention }: { taskId: number; rel: BigRelatedTask; card: BigTaskCard; mock: boolean; onMention: () => void }) {
  const q = useRelated(taskId, rel, mock);
  const bb = q.data?.descriptionBb || q.data?.description || '';
  const btn = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 text-[13px] hover:bg-[var(--color-bg-hover)]';
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {rel.responsible && <button type="button" className={btn} onClick={onMention} title="Вставить упоминание исполнителя в сообщение — Битрикс пришлёт ему уведомление">@ {shortPerson(rel.responsible.name)}</button>}
        {card.deal && <LogistRequestButton dealId={card.deal.id} mock={mock} className={btn} />}
        <a href={rel.url} target="_blank" rel="noreferrer" className={btn}><ExternalLink size={13} /> Открыть в Битриксе</a>
      </div>
      <Section title={rel.groupName ?? 'Связанная задача'} extra={<BxLink href={rel.url}>Задача № {rel.id}</BxLink>}>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="min-w-0 break-words font-medium">{rel.title}</p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--color-text-secondary)]">
            <span className={`rounded px-1.5 py-0.5 text-[11.5px] ${STATE_META[rel.state].cls}`}>{STATE_META[rel.state].label}</span>
            {rel.responsible && <span>Исполнитель: <b className="font-medium text-[var(--color-text)]">{rel.responsible.name}</b></span>}
            {rel.changedAt && <span>изм. {fmtDT(rel.changedAt)}</span>}
          </div>
          {q.isLoading && <p className="text-[var(--color-text-muted)]">Загружаю описание…</p>}
          {q.error && <p className="text-[var(--color-negative)]">{(q.error as Error).message}</p>}
          {bb ? <div className="rounded-md bg-[var(--color-bg-hover)] px-3 py-2"><BbText text={bb} /></div> : q.data && <p className="text-[var(--color-text-muted)]">Описания нет.</p>}
        </div>
      </Section>
    </>
  );
}

/** Чат связанной задачи — та же лента и тот же ввод, что у задачи БЧ; отправка — action related_comment. */
function RelatedChat({ taskId, rel, me, lastSeenAt, mock, inject, className = '' }: { taskId: number; rel: BigRelatedTask; me: string | null; lastSeenAt: string | null; mock: boolean; inject: { text: string; key: number } | null; className?: string }) {
  const [mockSent, setMockSent] = useState<BigChatMessage[]>([]);
  const q = useRelated(taskId, rel, mock);
  const chat = q.data?.chat ? [...q.data.chat, ...mockSent] : null;
  return (
    <section className={`flex min-h-0 min-w-0 flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] ${className}`}>
      {q.error && <p className="px-3 pt-2 text-[var(--color-negative)]">{(q.error as Error).message}</p>}
      <TaskThread messages={chat} viewerId={me} roles={rel.responsible ? { [rel.responsible.id]: 'исполнитель' } : {}} lastSeenAt={lastSeenAt}
        loading={q.isLoading} emptyText="Сообщений пока нет" className="min-h-40 flex-1 px-3 py-2" />
      <div className="border-t border-[var(--color-border)] p-2">
        <ThreadComposer compact mock={mock} inject={inject} placeholder={`Сообщение в задачу${rel.responsible ? ` (${rel.responsible.name})` : ''} — от вашего имени`}
          mentions={rel.responsible ? [{ id: rel.responsible.id, name: rel.responsible.name, role: 'исполнитель' }] : []}
          onSend={async (text, attachments) => {
            if (mock) { setMockSent(m => [...m, { id: Date.now(), authorId: me ?? 'me', author: 'Вы', at: new Date().toISOString(), text, system: false }]); return; }
            const r = await postBigAction({ type: 'related_comment', taskId, relatedTaskId: rel.id, text, attachments });
            await q.refetch();
            return r.warnings;
          }} />
      </div>
    </section>
  );
}

/** «Звонки и ИИ» (владелец 25.11: «ИИ-оценку сделки и ИИ-анализ свести вместе, можно на вкладке Звонки»). */
function CallsAndAi({ card, hasClient, contactId, companyId, mock, aiCheck }: {
  card: BigTaskCard; hasClient: boolean; contactId: number | null; companyId: number | null; mock: boolean; aiCheck: React.ReactNode;
}) {
  const params: Record<string, string> = companyId ? { companyId: String(companyId) } : contactId ? { contactId: String(contactId) } : {};
  const qs = new URLSearchParams(params).toString();
  const ai = useAiAnalysisAccess(qs, hasClient && !mock);
  const [sub, setSub] = useState<'calls' | 'check' | 'ai'>('calls');
  const subs: { k: 'calls' | 'check' | 'ai'; l: string }[] = [
    { k: 'calls', l: 'Разговоры' },
    ...(aiCheck ? [{ k: 'check' as const, l: 'ИИ-оценка сделки' }] : []),
    ...(ai.allowed ? [{ k: 'ai' as const, l: 'ИИ-анализ клиента' }] : []),
  ];
  if (!hasClient) return <p className="text-[var(--color-text-muted)]">У задачи нет сделки с клиентом — звонков не найти.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {subs.length > 1 && (
        <div role="tablist" aria-label="Звонки и ИИ" className="flex min-w-0 flex-wrap gap-1.5">
          {subs.map(x => (
            <button key={x.k} type="button" role="tab" aria-selected={sub === x.k} onClick={() => setSub(x.k)}
              className={`min-h-11 rounded-full border px-3.5 text-[12.5px] sm:min-h-9 ${sub === x.k ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>{x.l}</button>
          ))}
        </div>
      )}
      {sub === 'calls' && <CallsTab taskId={card.id} contactId={contactId} companyId={companyId} mock={mock} />}
      {sub === 'check' && aiCheck}
      {sub === 'ai' && ai.allowed && <AiAnalysisTab qs={qs} params={params} cardClientType={null} />}
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
