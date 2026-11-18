'use client';
// Канбан больших чеков (решения владельца 18.11, ai_docs/fresh_docs/BIG_DEALS_KANBAN_SPEC.md).
// Карточка = задача Битрикса из 6 проектов больших сделок. Колонки — общая сетка (engine/config
// BIG_COLUMNS), две вкладки: «Доска» и «Сегодня» (что делать прямо сейчас). Данные —
// GET /api/big-deals-kanban (контракт engine/types.ts), перенос — POST /api/big-deals-kanban/action.
// Перетаскивание — только мышью (десктоп, canManage); на таче перенос делается из карточки задачи.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HelpCircle, RefreshCw, Search, X } from 'lucide-react';
import { enumParam, listParam, stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import { useIsTouch } from '@/lib/hooks/useMediaQuery';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import type { BigColumnKey } from '../engine/config';
import type { BigBoardResponse, BigColumnData, BigTaskCard } from '../engine/types';
import { BigTaskCardView } from './BigTaskCardView';
import { TaskDrawer } from './TaskDrawer';
import { fmtDT, moneyShort, plural } from './format';
import { mockBoard } from './mockBoard';

const VIEWS = ['board', 'today'] as const;
const BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm transition-colors';
const BTN_IDLE = `${BTN} border-[var(--color-border)] bg-[var(--color-bg-surface)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`;

class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

/** Текст на цветной шапке колонки: тёмный на светлых (жёлтый, голубой), белый на тёмных. */
function textOn(hex: string) {
  const n = parseInt(hex, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 165 ? '#1f2328' : '#ffffff';
}

const cardSum = (cards: BigTaskCard[]) => cards.reduce((s, c) => s + (c.deal?.amount || c.taskAmount || 0), 0);

/** Карточку — в её колонку (card.column), из остальных убрать; в «Сегодня» — заменить на месте. */
function placeCard(d: BigBoardResponse, card: BigTaskCard): BigBoardResponse {
  const columns = d.columns.map(col => {
    const had = col.cards.some(c => c.id === card.id);
    const rest = col.cards.filter(c => c.id !== card.id);
    if (col.key === card.column) {
      const cards = had ? col.cards.map(c => (c.id === card.id ? card : c)) : [card, ...rest];
      return { ...col, cards, total: col.total + (had ? 0 : 1), sum: cardSum(cards) };
    }
    return had ? { ...col, cards: rest, total: Math.max(0, col.total - 1), sum: cardSum(rest) } : col;
  });
  const today = d.today.map(s => ({ ...s, cards: s.cards.map(c => (c.id === card.id ? card : c)) }));
  return { ...d, columns, today };
}

function findCard(d: BigBoardResponse | undefined, id: number): BigTaskCard | null {
  if (!d || !id) return null;
  for (const col of d.columns) for (const c of col.cards) if (c.id === id) return c;
  for (const s of d.today) for (const c of s.cards) if (c.id === id) return c;
  return null;
}

export function BigDealsKanbanPage() {
  const qc = useQueryClient();
  const [view, setView] = useUrlState('view', { ...enumParam(VIEWS, 'board'), mode: 'push' });
  const [groupSel, setGroupSel] = useUrlState('group', listParam([]));
  const [manager, setManager] = useUrlState('manager', stringParam(''));
  // Через «|»: в названиях товарных групп бывают запятые («Бордюры (поребрики, бортовые камни)»).
  const [products, setProducts] = useUrlState('product', {
    ...listParam([]),
    parse: (raw: string) => (raw === '' ? [] : raw.split('|').filter(Boolean)),
    serialize: (v: string[]) => { const d = [...new Set(v)]; return d.length ? d.join('|') : null; },
  });
  const [q, setQ] = useUrlState('q', stringParam(''));
  const [taskParam, setTaskParam] = useUrlState('task', { ...stringParam(''), mode: 'push' });
  const [mockParam] = useUrlState('mock', stringParam(''));
  // Моковая доска — только в dev (проверка экрана без движка/входа). В проде флаг ничего не делает.
  const mock = process.env.NODE_ENV !== 'production' && mockParam === '1';
  const isTouch = useIsTouch();

  // Поиск: печатаем локально, в URL и запрос — с паузой (не дёргать API каждой буквой).
  const [qInput, setQInput] = useState(q);
  useEffect(() => { setQInput(q); }, [q]);
  useEffect(() => {
    if (qInput === q) return;
    const t = setTimeout(() => setQ(qInput.trim()), 400);
    return () => clearTimeout(t);
  }, [qInput, q, setQ]);

  const queryKey = useMemo(() => ['big-deals-kanban', mock ? 'mock' : '', groupSel.join(','), manager, products.join(','), q], [mock, groupSel, manager, products, q]);
  const { data, error, isLoading, isFetching, refetch } = useQuery<BigBoardResponse, ApiError>({
    queryKey,
    queryFn: async () => {
      if (mock) return mockBoard();
      const p = new URLSearchParams();
      if (groupSel.length) p.set('group', groupSel.join(','));
      if (manager) p.set('manager', manager);
      if (products.length) p.set('product', products.join('|'));
      if (q) p.set('q', q);
      const r = await fetch(`/api/big-deals-kanban${p.size ? `?${p}` : ''}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(r.status, j.error ?? `Ошибка ${r.status}`);
      return j as BigBoardResponse;
    },
    refetchInterval: mock ? false : 60_000,
    staleTime: mock ? Infinity : 30_000,
    placeholderData: prev => prev,
  });

  // Тост об ошибке переноса (откат уже сделан).
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const moveCard = useCallback(async (card: BigTaskCard, column: BigColumnKey) => {
    if (card.column === column) return;
    await qc.cancelQueries({ queryKey });
    const prev = qc.getQueryData<BigBoardResponse>(queryKey);
    if (!prev) return;
    qc.setQueryData<BigBoardResponse>(queryKey, placeCard(prev, { ...card, column, daysInColumn: 0, stuck: false, inColumnSince: new Date().toISOString() }));
    if (mock) return;
    try {
      const r = await fetch('/api/big-deals-kanban/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'move', taskId: card.id, column }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error ?? `Ошибка ${r.status}`);
      if (j.card) qc.setQueryData<BigBoardResponse>(queryKey, d => (d ? placeCard(d, j.card as BigTaskCard) : d));
    } catch (e) {
      qc.setQueryData(queryKey, prev);
      setToast(`Не удалось перенести задачу № ${card.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [qc, queryKey, mock]);

  // Открытая карточка — в URL (?task=), чтобы ссылку можно было переслать. Если после фильтра
  // задачи на доске нет — держим последний открытый снимок, чтобы окно не схлопнулось.
  const lastOpened = useRef<BigTaskCard | null>(null);
  const openCard = useMemo(() => {
    const id = Number(taskParam);
    const found = findCard(data, id);
    if (found) return found;
    return lastOpened.current?.id === id ? lastOpened.current : null;
  }, [data, taskParam]);
  useEffect(() => { if (openCard) lastOpened.current = openCard; }, [openCard]);
  const onOpen = useCallback((c: BigTaskCard) => { lastOpened.current = c; setTaskParam(String(c.id)); }, [setTaskParam]);

  const canManage = !!data?.canManage;
  const dragEnabled = canManage && !isTouch;

  const groupOptions = data?.groups ?? [];
  const selectedGroupIds = useMemo(
    () => (groupSel.length ? groupSel.map(Number) : groupOptions.map(g => g.id)),
    [groupSel, groupOptions],
  );
  const toggleGroup = (id: number) => {
    const s = String(id);
    setGroupSel(groupSel.includes(s) ? groupSel.filter(x => x !== s) : [...groupSel, s]);
  };
  const todayCount = useMemo(() => new Set((data?.today ?? []).flatMap(s => s.cards.map(c => c.id))).size, [data]);
  const filtersOn = groupSel.length > 0 || !!manager || products.length > 0 || !!q;
  const reset = () => { setGroupSel([]); setManager(''); setProducts([]); setQ(''); setQInput(''); };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto overflow-x-hidden sm:overflow-hidden">
      <div className="flex min-w-0 shrink-0 flex-col gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
        <header className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Канбан больших чеков</h1>
          {data && (
            <span className="text-xs text-[var(--color-text-muted)]">обновлено {fmtDT(data.generatedAt)}</span>
          )}
          {(data?.stale || (isFetching && !!data)) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg-surface)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]">
              <RefreshCw size={11} className="animate-spin" aria-hidden />обновляется…
            </span>
          )}
          {mock && <span className="rounded bg-[var(--color-warning)]/15 px-1.5 py-0.5 text-xs text-[var(--color-warning)]">моковые данные (dev)</span>}
        </header>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <div className="flex gap-1 rounded-lg border border-[var(--color-border)] p-0.5" role="tablist" aria-label="Вид">
            <button type="button" role="tab" aria-selected={view === 'board'} onClick={() => setView('board')}
              className={`inline-flex min-h-10 items-center rounded-md px-3 text-sm ${view === 'board' ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>Доска</button>
            <button type="button" role="tab" aria-selected={view === 'today'} onClick={() => setView('today')}
              title="Что сделать прямо сейчас: принять работу, разобрать новые, сдвинуть застрявшие"
              className={`inline-flex min-h-10 items-center gap-1 rounded-md px-3 text-sm ${view === 'today' ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
              Сегодня{data ? <span className={view === 'today' ? 'opacity-80' : 'text-[var(--color-text-muted)]'}>· {todayCount}</span> : null}
            </button>
          </div>
          <label className="relative flex min-w-0 flex-1 basis-56 items-center sm:max-w-72">
            <Search size={15} className="pointer-events-none absolute left-3 text-[var(--color-text-muted)]" aria-hidden />
            <input value={qInput} onChange={e => setQInput(e.target.value)} placeholder="Поиск: текст или № задачи"
              aria-label="Поиск по задачам" inputMode="search"
              className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] pl-9 pr-9 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-border-focus)] sm:text-sm" />
            {qInput && (
              <button type="button" onClick={() => { setQInput(''); setQ(''); }} aria-label="Очистить поиск"
                className="tap-target absolute right-2 rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X size={14} /></button>
            )}
          </label>
          {(data?.managers.length ?? 0) > 0 && (
            <SearchSelect ariaLabel="Менеджер" value={manager} onChange={setManager} allLabel="Все менеджеры" searchable
              searchPlaceholder="Поиск менеджера" className="min-w-0 max-w-full"
              options={(data?.managers ?? []).map(m => ({ value: m.id, label: m.name }))} />
          )}
          {(data?.productGroups.length ?? 0) > 0 && (
            <SearchMultiSelect ariaLabel="Товарные группы" allLabel="Любая товарная группа" unitLabel="групп" searchPlaceholder="Поиск группы"
              value={products} onChange={setProducts} className="min-w-0 max-w-full"
              options={(data?.productGroups ?? []).map(p => ({ value: p, label: p }))} />
          )}
          {filtersOn && (
            <button type="button" onClick={reset} className={BTN_IDLE}><X size={14} aria-hidden />Сбросить</button>
          )}
          <Link href="/big-deals-kanban/guide" className={`${BTN_IDLE} sm:ml-auto`} title="Инструкция: как работать с канбаном больших чеков" aria-label="Как работать?">
            <HelpCircle size={16} aria-hidden /> <span className="hidden min-[420px]:inline">Как работать?</span>
          </Link>
        </div>

        {groupOptions.length > 0 && (
          // Проектов шесть — переносом строки, без горизонтальной ленты (CLAUDE.md, правило 12, вариант flex-wrap).
          <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Проекты">
            <button type="button" onClick={() => setGroupSel([])} aria-pressed={groupSel.length === 0}
              className={`inline-flex min-h-11 items-center rounded-full border px-3 text-sm ${groupSel.length === 0 ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
              Все проекты
            </button>
            {groupOptions.map(g => {
              const on = groupSel.includes(String(g.id));
              return (
                <button key={g.id} type="button" onClick={() => toggleGroup(g.id)} aria-pressed={on} title={g.name}
                  className={`inline-flex min-h-11 items-center rounded-full border px-3 text-sm ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                  {g.short}
                </button>
              );
            })}
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">
            {error.status === 403 ? 'Недостаточно прав для канбана больших чеков.' : error.message}
            {error.status !== 403 && <button type="button" onClick={() => refetch()} className="ml-2 underline">Повторить</button>}
          </div>
        )}
        {isLoading && !data && !error && (
          <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Собираю доску — задачи, сделки и звонки…</div>
        )}
      </div>

      {data && (view === 'today' ? (
        <TodayView data={data} onOpen={onOpen} />
      ) : (
        <Board data={data} selectedGroupIds={selectedGroupIds} dragEnabled={dragEnabled} onOpen={onOpen} onMove={moveCard} />
      ))}

      {openCard && (
        <TaskDrawer card={openCard} canManage={canManage} managers={data?.managers ?? []}
          onClose={() => setTaskParam('')}
          onChanged={card => {
            if (card) qc.setQueryData<BigBoardResponse>(queryKey, d => (d ? placeCard(d, card) : d));
            if (!mock) qc.invalidateQueries({ queryKey: ['big-deals-kanban'] });
          }} />
      )}

      {toast && (
        <div role="alert" className="fixed bottom-4 left-1/2 z-50 w-max max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg bg-[var(--color-negative)] px-4 py-3 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

// ── Доска ────────────────────────────────────────────────────────────────────

function Board({ data, selectedGroupIds, dragEnabled, onOpen, onMove }: {
  data: BigBoardResponse;
  selectedGroupIds: number[];
  dragEnabled: boolean;
  onOpen: (c: BigTaskCard) => void;
  onMove: (c: BigTaskCard, column: BigColumnKey) => void;
}) {
  const [drag, setDrag] = useState<BigTaskCard | null>(null);
  const [over, setOver] = useState<BigColumnKey | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, data]);

  const canDrop = (col: BigColumnData) => !!drag && col.key !== drag.column && col.groupIds.includes(drag.groupId);

  return (
    <div className="relative min-h-[75dvh] min-w-0 flex-1 px-4 pb-4 pt-3 sm:min-h-0 sm:px-6">
      <div ref={scrollRef} onScroll={measure} className="scroll-x h-full">
        <div className="flex h-full items-stretch gap-2.5">
          {data.columns.map(col => {
            // Колонки, которой нет ни у одного выбранного проекта и в которой пусто, — узкая полоска.
            const collapsed = col.cards.length === 0 && !col.groupIds.some(id => selectedGroupIds.includes(id));
            const dropOk = canDrop(col);
            const dim = !!drag && !dropOk && col.key !== drag.column;
            if (collapsed) {
              return (
                <div key={col.key} title={`«${col.title}» — нет у выбранных проектов`}
                  className={`flex h-full w-9 shrink-0 flex-col items-center gap-2 rounded-xl bg-[var(--color-bg-surface)] py-2 ${dim ? 'opacity-40' : ''}`}>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: `#${col.color}` }} aria-hidden />
                  <span className="text-xs text-[var(--color-text-muted)] [writing-mode:vertical-rl]">{col.title}</span>
                </div>
              );
            }
            return (
              <section key={col.key} data-column={col.key}
                onDragOver={e => { if (dropOk) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== col.key) setOver(col.key); } }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(o => (o === col.key ? null : o)); }}
                onDrop={e => { e.preventDefault(); const c = drag; setDrag(null); setOver(null); if (c && dropOk) onMove(c, col.key); }}
                className={`flex h-full w-72 max-w-[85vw] shrink-0 flex-col overflow-hidden rounded-xl bg-[var(--color-bg-surface)] transition-opacity ${dim ? 'opacity-40' : ''} ${over === col.key ? 'ring-2 ring-[var(--color-accent)]' : ''}`}>
                <header className="shrink-0 px-2.5 py-2" style={{ background: `#${col.color}`, color: textOn(col.color) }}>
                  <div className="flex min-w-0 items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-semibold" title={col.title}>{col.title}</span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{col.total}</span>
                  </div>
                  <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs opacity-85">
                    <span className="min-w-0 truncate">{col.hint ?? ''}</span>
                    {col.sum > 0 && <span className="shrink-0 tabular-nums">{moneyShort(col.sum)}</span>}
                  </div>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden p-2">
                  {col.cards.map(c => (
                    <BigTaskCardView key={c.id} card={c} onOpen={onOpen}
                      draggable={dragEnabled}
                      dragging={drag?.id === c.id}
                      onDragStart={setDrag}
                      onDragEnd={() => { setDrag(null); setOver(null); }} />
                  ))}
                  {col.cards.length === 0 && <div className="px-1 py-3 text-center text-xs text-[var(--color-text-muted)]">пусто</div>}
                  {col.total > col.cards.length && (
                    <div className="px-1 text-center text-xs text-[var(--color-text-muted)]">ещё {col.total - col.cards.length} — уточните фильтр</div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      {edges.left && <div aria-hidden className="pointer-events-none absolute inset-y-0 left-4 w-8 bg-gradient-to-r from-[var(--color-bg)] to-transparent sm:left-6" />}
      {edges.right && <div aria-hidden className="pointer-events-none absolute inset-y-0 right-4 w-8 bg-gradient-to-l from-[var(--color-bg)] to-transparent sm:right-6" />}
    </div>
  );
}

// ── Сегодня ──────────────────────────────────────────────────────────────────

function TodayView({ data, onOpen }: { data: BigBoardResponse; onOpen: (c: BigTaskCard) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-5 px-4 pb-6 pt-3 sm:min-h-0 sm:flex-1 sm:overflow-y-auto sm:px-6">
      {data.today.map(sec => (
        <section key={sec.key} className="min-w-0">
          <div className="mb-2 flex min-w-0 flex-wrap items-baseline gap-x-2">
            <h2 className="text-base font-semibold text-[var(--color-text)]">{sec.title}</h2>
            <span className="text-sm tabular-nums text-[var(--color-text-muted)]">
              {sec.cards.length} {plural(sec.cards.length, 'задача', 'задачи', 'задач')}
            </span>
            <span className="basis-full text-xs text-[var(--color-text-muted)] sm:basis-auto">{sec.hint}</span>
          </div>
          {sec.cards.length === 0 ? (
            <div className="text-sm text-[var(--color-text-muted)]">нет</div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {sec.cards.map(c => <BigTaskCardView key={c.id} card={c} onOpen={onOpen} />)}
            </div>
          )}
        </section>
      ))}
      {data.today.length === 0 && <div className="text-sm text-[var(--color-text-muted)]">На сегодня ничего срочного.</div>}
    </div>
  );
}
