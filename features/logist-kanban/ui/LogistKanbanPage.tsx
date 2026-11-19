'use client';
// «Канбан логиста» — запросы менеджеров логистам (LOGIST_REQUESTS_SPEC.md; заменил 19.11 прототип на заявках 1С).
// Данные — GET /api/logist-kanban/board (контракт engine/requests/contract.ts), фильтры — в URL (useLogistFilters),
// открытый запрос — ?req=<id> (RequestDrawer), настройки очередей и весов — ?modal=settings (canManage).
// Виды: «Доска» (Новые / В работе / Ждут контроля / Приняты; тип — чипом на карточке) и «Сделки» (Проданы / Забракованы).
// Колонки сортирует сервер (приоритет по умолчанию). Перетаскивания нет: действия — кнопками в карточке,
// одинаково на компьютере и телефоне. Телефон/планшет (< lg): одна колонка за раз, переключатель — чипы с
// переносом строки (CLAUDE.md, правило 12 — без горизонтальной ленты); компьютер — все колонки сеткой.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, FilePen, HelpCircle, RefreshCw, Search, Settings, User, UserX, X } from 'lucide-react';
import { enumParam, intParam, stringParam, useUrlModal, useUrlState } from '@/lib/hooks/useUrlState';
import {
  BOARD_COLUMNS, REQUEST_TYPES, REQUEST_TYPE_LABEL,
  type BoardColumnKey, type BoardResponse, type BoardView, type RequestCard, type Tiles,
} from '../engine/requests/contract';
import { lkFetch, LogistApiError } from './api';
import { ActiveChips, BTN_ACTIVE, BTN_IDLE, FiltersButton, ResetAllButton } from './FiltersPanel';
import { RequestCardView } from './RequestCardView';
import { RequestDrawer } from './RequestDrawer';
import { SettingsDrawer } from './SettingsDrawer';
import { useLogistFilters } from './useLogistFilters';
import { TYPE_META, cardTitle, fmtDT, hours, moneyShort } from './format';

const VIEWS = ['board', 'deals'] as const;
const COL_TONE: Record<BoardColumnKey, string> = {
  draft: 'var(--color-text-muted)', new: 'var(--color-accent)', in_work: 'var(--color-warning)', answered: 'var(--color-positive)',
  accepted: 'var(--color-positive)', cancelled: 'var(--color-negative)', sold: 'var(--color-positive)', lost: 'var(--color-negative)',
};
const COL_HINT: Partial<Record<BoardColumnKey, string>> = {
  new: 'В очереди, никто не взял',
  in_work: 'Логист ищет цену и срок',
  answered: 'Ответ дан — менеджер принимает или возвращает',
  accepted: 'Менеджер принял вариант',
  sold: 'Сделка по запросу продана',
  lost: 'Сделка по запросу проиграна',
};

export function LogistKanbanPage() {
  const qc = useQueryClient();
  const [view, setView] = useUrlState('view', { ...enumParam(VIEWS, 'board'), mode: 'push' });
  const [reqId, setReqId] = useUrlState('req', { ...intParam(0), mode: 'push' });
  const [colParam, setColParam] = useUrlState('col', stringParam(''));
  const settings = useUrlModal();
  const f = useLogistFilters();
  const { filters } = f;

  // Поиск: печатаем локально, в URL — с паузой (не дёргать API каждой буквой).
  const [qInput, setQInput] = useState(filters.q ?? '');
  useEffect(() => { setQInput(filters.q ?? ''); }, [filters.q]);
  useEffect(() => {
    const v = qInput.trim();
    if (v === (filters.q ?? '')) return;
    const t = setTimeout(() => f.set('q', v || undefined), 400);
    return () => clearTimeout(t);
  }, [qInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const queryKey = ['logist-board', view, f.queryString];
  const { data, error, isLoading, isFetching, refetch } = useQuery<BoardResponse, LogistApiError>({
    queryKey,
    queryFn: () => lkFetch<BoardResponse>(`/api/logist-kanban/board?view=${view}${f.queryString ? `&${f.queryString}` : ''}`),
    placeholderData: prev => (prev?.view === view ? prev : undefined),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const columns = data?.columns ?? BOARD_COLUMNS[view].map(c => ({ ...c, total: 0, cards: [] as RequestCard[] }));
  const activeCol = (columns.find(c => c.key === colParam)?.key ?? columns[0]?.key) as BoardColumnKey;

  const openCard = (c: RequestCard) => setReqId(c.id);
  const refreshBoard = () => { void qc.invalidateQueries({ queryKey: ['logist-board'] }); };
  const me = data?.me;
  const toggleType = (t: (typeof REQUEST_TYPES)[number] | null) => f.set('types', t ? [t] : undefined);
  const typeSel = filters.types?.length === 1 ? filters.types[0] : null;
  const chip = (on: boolean) => `inline-flex min-h-11 items-center gap-1 rounded-full border px-3 text-sm ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`;
  const tabCls = (on: boolean) => `inline-flex min-h-10 items-center gap-1 rounded-md px-3 text-sm ${on ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto overflow-x-hidden">
      <div className="flex min-w-0 shrink-0 flex-col gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
        <header className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Канбан логиста</h1>
          {me && (
            <span className="text-xs text-[var(--color-text-muted)]">
              {me.canManage ? 'руководитель логистики — весь поток' : me.isLogist ? `ваших очередей: ${me.queueIds.length}` : me.isRop ? 'запросы менеджеров вашей зоны' : 'ваши запросы'}
            </span>
          )}
          {isFetching && !!data && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg-surface)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]">
              <RefreshCw size={11} className="animate-spin" aria-hidden />обновляется…
            </span>
          )}
        </header>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <div className="flex gap-1 rounded-lg border border-[var(--color-border)] p-0.5" role="tablist" aria-label="Вид">
            <button type="button" role="tab" aria-selected={view === 'board'} onClick={() => setView('board')} className={tabCls(view === 'board')}>Доска</button>
            <button type="button" role="tab" aria-selected={view === 'deals'} onClick={() => setView('deals')} className={tabCls(view === 'deals')}
              title="Исход сделок по запросам: проданы и забракованы">Сделки</button>
          </div>
          <label className="relative flex min-w-0 flex-1 basis-56 items-center sm:max-w-80">
            <Search size={15} className="pointer-events-none absolute left-3 text-[var(--color-text-muted)]" aria-hidden />
            <input value={qInput} onChange={e => setQInput(e.target.value)} placeholder="№ запроса, сделка, заказчик, товар"
              aria-label="Поиск по запросам" inputMode="search"
              className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] pl-9 pr-9 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-border-focus)] sm:text-sm" />
            {qInput && (
              <button type="button" onClick={() => { setQInput(''); f.set('q', undefined); }} aria-label="Очистить поиск"
                className="tap-target absolute right-2 rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X size={14} /></button>
            )}
          </label>
          <button type="button" onClick={() => f.set('mine', filters.mine ? undefined : true)} aria-pressed={!!filters.mine}
            className={filters.mine ? BTN_ACTIVE : BTN_IDLE} title="Запросы, где вы логист или менеджер">
            <User size={16} aria-hidden /> Только мои
          </button>
          <button type="button" onClick={() => f.set('untaken', filters.untaken ? undefined : true)} aria-pressed={!!filters.untaken}
            className={filters.untaken ? BTN_ACTIVE : BTN_IDLE} title="Новые запросы, которые ещё никто не взял">
            <UserX size={16} aria-hidden /> Не взятые
          </button>
          <FiltersButton s={f} options={data?.options} />
          <ResetAllButton s={f} onReset={() => setQInput('')} />
          <span className="flex gap-1.5 sm:ml-auto">
            {me?.canManage && (
              <button type="button" onClick={() => settings.open('settings')} className={BTN_IDLE} title="Очереди, состав из Битрикса, SLA и веса приоритета" aria-label="Настройки">
                <Settings size={16} aria-hidden /> <span className="hidden min-[420px]:inline">Настройки</span>
              </button>
            )}
            {(me?.canManage || me?.isRop) && (
              <Link href="/profile/logist-requests?tab=analytics" className={BTN_IDLE} title="Аналитика: плитки и разрез регион → департамент → очередь → логист" aria-label="Аналитика">
                <BarChart3 size={16} aria-hidden /> <span className="hidden min-[420px]:inline">Аналитика</span>
              </Link>
            )}
            <Link href="/logist-kanban/guide" className={BTN_IDLE} title="Инструкция: как работать с канбаном логиста" aria-label="Как работать?">
              <HelpCircle size={16} aria-hidden /> <span className="hidden min-[420px]:inline">Как работать?</span>
            </Link>
          </span>
        </div>

        {/* Тип запроса — чипами (два типа — переносом строки, без ленты). */}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Тип запроса">
          <button type="button" onClick={() => toggleType(null)} aria-pressed={!typeSel} className={chip(!typeSel)}>Все типы</button>
          {REQUEST_TYPES.map(t => (
            <button key={t} type="button" onClick={() => toggleType(typeSel === t ? null : t)} aria-pressed={typeSel === t} className={chip(typeSel === t)}>
              <span className={`h-2 w-2 rounded-full ${TYPE_META[t].cls}`} style={{ background: 'currentColor' }} aria-hidden />
              <span className="sm:hidden">{TYPE_META[t].short}</span><span className="hidden sm:inline">{REQUEST_TYPE_LABEL[t]}</span>
            </button>
          ))}
        </div>

        <ActiveChips s={f} options={data?.options} />

        {data && <TilesRow tiles={data.tiles} />}

        {data && data.drafts.length > 0 && <DraftsStrip drafts={data.drafts} onOpen={openCard} />}

        {error && (
          <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">
            {error.status === 403 ? 'Недостаточно прав для канбана логиста.' : error.message}
            {error.status !== 403 && <button type="button" onClick={() => refetch()} className="ml-2 min-h-11 underline">Повторить</button>}
          </div>
        )}
        {isLoading && !data && !error && (
          <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Собираю доску…</div>
        )}
        {data?.notice && <div className="text-xs text-[var(--color-text-muted)]">{data.notice}</div>}

        {/* Телефон/планшет: какая колонка видна. */}
        <div className="flex min-w-0 flex-wrap gap-1.5 lg:hidden" role="tablist" aria-label="Колонка">
          {columns.map(col => (
            <button key={col.key} type="button" role="tab" aria-selected={activeCol === col.key} onClick={() => setColParam(col.key === columns[0].key ? '' : col.key)}
              className={chip(activeCol === col.key)}>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: COL_TONE[col.key] }} aria-hidden />
              {col.title}<span className="tabular-nums opacity-70">{col.total}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={`grid min-w-0 flex-1 gap-2.5 px-4 pb-6 pt-3 sm:px-6 ${view === 'board' ? 'lg:grid-cols-4' : 'lg:grid-cols-2'}`}>
        {columns.map(col => (
          <section key={col.key} aria-label={col.title}
            className={`${activeCol === col.key ? 'flex' : 'hidden'} min-w-0 flex-col rounded-xl bg-[var(--color-bg-surface)] lg:flex`}>
            <div className="flex min-w-0 items-baseline gap-2 px-3 pt-2.5">
              <span className="h-2.5 w-2.5 shrink-0 self-center rounded-full" style={{ background: COL_TONE[col.key] }} aria-hidden />
              <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--color-text)]">{col.title}</h2>
              <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{col.total}</span>
              <span className="ml-auto truncate text-xs tabular-nums text-[var(--color-text-muted)]">{moneyShort(col.cards.reduce((s, c) => s + c.amount, 0))}</span>
            </div>
            {COL_HINT[col.key] && <div className="px-3 text-[11px] text-[var(--color-text-muted)]">{COL_HINT[col.key]}</div>}
            <div className="flex min-w-0 flex-col gap-2 p-2">
              {col.cards.map(c => <RequestCardView key={c.id} card={c} onOpen={openCard} />)}
              {data && col.cards.length === 0 && <div className="px-1 py-3 text-center text-xs text-[var(--color-text-muted)]">пусто</div>}
              {col.total > col.cards.length && (
                <div className="px-1 text-center text-xs text-[var(--color-text-muted)]">ещё {col.total - col.cards.length} — уточните фильтр</div>
              )}
            </div>
          </section>
        ))}
      </div>

      {reqId > 0 && (
        <RequestDrawer id={reqId} hint={findCard(data, reqId)} queues={data?.options.queues ?? []} me={me?.bitrixId ?? null}
          onClose={() => setReqId(0)} onChanged={refreshBoard} />
      )}
      {settings.isOpen('settings') && me?.canManage && <SettingsDrawer onClose={settings.close} onChanged={refreshBoard} />}
    </div>
  );
}

function findCard(d: BoardResponse | undefined, id: number): RequestCard | null {
  if (!d) return null;
  for (const col of d.columns) for (const c of col.cards) if (c.id === id) return c;
  return d.drafts.find(c => c.id === id) ?? null;
}

const pDate = (ymd: string) => ymd.slice(0, 10).split('-').reverse().slice(0, 2).join('.');

export function TilesRow({ tiles: t }: { tiles: Tiles }) {
  const items: { label: string; short: string; value: string; hint: string }[] = [
    { label: 'Новые', short: 'Новые', value: String(t.newCount), hint: 'Отправлено запросов за период' },
    { label: 'Возобновлённые', short: 'Возвраты', value: String(t.reopenedCount), hint: 'Возвратов на доработку за период' },
    { label: 'Скорость взятия', short: 'Взятие', value: hours(t.takeSpeedH), hint: 'Скорость взятия — медиана: старт цикла → «Взять», рабочие часы 9–18 МСК' },
    { label: 'Скорость ответа', short: 'Ответ', value: hours(t.answerSpeedH), hint: 'Скорость ответа — медиана: старт цикла → первый вариант' },
    { label: 'Скорость выполнения', short: 'Выполнение', value: hours(t.execSpeedH), hint: 'Скорость выполнения — медиана: «Взять» → ответ' },
    { label: 'Сумма продаж', short: 'Продажи', value: t.salesSum ? moneyShort(t.salesSum) : '—', hint: `Сумма продаж — проданные сделки по запросам периода: ${t.salesCount}` },
  ];
  return (
    <section aria-label="Показатели за период" className="flex min-w-0 flex-col gap-1">
      <div className="text-[11px] text-[var(--color-text-muted)]">За период {pDate(t.periodFrom)}–{pDate(t.periodTo)} · с учётом фильтров</div>
      <div className="grid min-w-0 grid-cols-3 gap-1.5 sm:gap-2 lg:grid-cols-6">
        {items.map(i => (
          <div key={i.label} title={i.hint} className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2 py-1.5 sm:px-3 sm:py-2">
            <div className="truncate text-[11px] text-[var(--color-text-muted)] sm:text-[11.5px]"><span className="sm:hidden">{i.short}</span><span className="hidden sm:inline">{i.label}</span></div>
            <div className="truncate text-[15px] font-semibold tabular-nums text-[var(--color-text)] sm:text-lg">{i.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DraftsStrip({ drafts, onOpen }: { drafts: RequestCard[]; onOpen: (c: RequestCard) => void }) {
  return (
    <section aria-label="Ваши черновики" className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-dashed border-[var(--color-border)] p-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
        <FilePen size={14} aria-hidden /> Ваши черновики — не отправлены логисту ({drafts.length})
      </div>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {drafts.map(d => (
          <button key={d.id} type="button" onClick={() => onOpen(d)}
            className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-left text-[13px] hover:bg-[var(--color-bg-hover)]">
            <span className={`shrink-0 rounded px-1 text-[10.5px] font-semibold ${TYPE_META[d.type].cls}`}>{TYPE_META[d.type].short}</span>
            <span className="min-w-0 truncate">{cardTitle(d)}</span>
            <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{fmtDT(d.createdAt)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
