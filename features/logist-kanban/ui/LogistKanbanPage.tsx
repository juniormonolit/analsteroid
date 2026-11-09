'use client';
// «Канбан логиста» (владелец 09.11, прототип). Логист фильтрует заявки 1С — филиал, сумма
// заявки от N, статусы 1С, товар/группа — смотрит, что и почём продал менеджер (карточка
// заявки с составом и закупками), берёт в проработку и ставит итог.
// Колонки: Можно попробовать → В работе → Успешно / Не вышло. Двигаем кнопками, не
// перетаскиванием: на телефоне drag-n-drop неудобен, а кнопки одинаковы везде.
// Телефон/планшет (< lg): одна колонка за раз, переключатель — чипы с переносом (flex-wrap,
// CLAUDE.md п.12 — без горизонтальной ленты).

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, AlertTriangle, RotateCcw, Play, Check, X, Search } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import { RequestCardPanel } from '@/features/realizations/ui/RequestCardPanel';
import { fmtDate, fmtInt, fmtMlnRub, fmtRub, humanName } from '@/features/realizations/ui/format';
import type { BoardCard, CardStatus } from '../engine/board';

interface Board {
  cards: BoardCard[];
  poolTotal: number;
  statuses: { value: string; n: number }[];
  readOnly: boolean;
}

const COLUMNS: { key: CardStatus; label: string; tone: string }[] = [
  { key: 'pool', label: 'Можно попробовать', tone: 'var(--color-text-muted)' },
  { key: 'in_work', label: 'В работе', tone: 'var(--brand)' },
  { key: 'success', label: 'Успешно', tone: 'var(--color-positive)' },
  { key: 'fail', label: 'Не вышло', tone: 'var(--color-negative)' },
];

const REGION_OPTIONS = [
  { value: 'МСК', label: 'Москва' },
  { value: 'СПБ', label: 'Санкт-Петербург' },
  { value: 'КРД', label: 'Краснодар' },
  { value: 'Без региона', label: 'Без филиала' },
];
const DAYS_OPTIONS = [7, 14, 30, 60, 90, 180].map(d => ({ value: String(d), label: `Заявки за ${d} дн.` }));
const POOL_PAGE = 100;

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

const inputCls = 'focus-ring h-11 sm:h-9 min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-base sm:text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]';

export function LogistKanbanPage() {
  const qc = useQueryClient();
  const [region, setRegion] = useState('МСК');
  const [minDraft, setMinDraft] = useState('250000');
  const [statuses, setStatuses] = useState<string[]>([]);
  const [goodsDraft, setGoodsDraft] = useState('');
  const [days, setDays] = useState('60');
  const [mine, setMine] = useState(false);
  const [col, setCol] = useState<CardStatus>('pool');
  const [open, setOpen] = useState<BoardCard | null>(null);
  const [poolShown, setPoolShown] = useState(POOL_PAGE);

  const minAmount = useDebounced(Number(minDraft.replace(/\D/g, '')) || 0, 500);
  const goods = useDebounced(goodsDraft.trim(), 500);
  const params = useMemo(() => {
    const p = new URLSearchParams({ days, min: String(minAmount) });
    if (region) p.set('region', region);
    if (statuses.length) p.set('statuses', statuses.join('\u0001'));
    if (goods) p.set('goods', goods);
    if (mine) p.set('mine', '1');
    return p.toString();
  }, [region, minAmount, statuses, goods, days, mine]);
  useEffect(() => setPoolShown(POOL_PAGE), [params]);

  const q = useQuery<Board>({
    queryKey: ['logist-kanban', params],
    queryFn: async () => {
      const res = await fetch(`/api/logist-kanban?${params}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Ошибка ${res.status}`);
      return body;
    },
    placeholderData: prev => prev,
  });

  const move = useMutation({
    mutationFn: async (v: { card: BoardCard; status: CardStatus }) => {
      const res = await fetch('/api/logist-kanban', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: v.card.key, requestId: v.card.id, status: v.status }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Ошибка ${res.status}`);
    },
    onSuccess: (_d, v) => {
      setOpen(o => (o && o.key === v.card.key ? { ...o, board: v.status } : o));
      qc.invalidateQueries({ queryKey: ['logist-kanban'] });
    },
  });

  const byCol = useMemo(() => {
    const m: Record<CardStatus, BoardCard[]> = { pool: [], in_work: [], success: [], fail: [] };
    for (const c of q.data?.cards ?? []) m[c.board].push(c);
    return m;
  }, [q.data]);

  const statusOptions = useMemo(() => {
    const known = new Map((q.data?.statuses ?? []).map(s => [s.value, s.n]));
    for (const s of statuses) if (!known.has(s)) known.set(s, 0);
    return [...known].map(([value, n]) => ({ value, label: value, hint: `${fmtInt(n)} заявок` }));
  }, [q.data, statuses]);

  const readOnly = q.data?.readOnly ?? false;
  const actionsFor = (c: BoardCard) => (
    <CardActions card={c} disabled={readOnly || move.isPending} onMove={s => move.mutate({ card: c, status: s })} />
  );

  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto overflow-x-hidden">
      <div className="flex min-w-0 flex-col gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
        <header className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Канбан логиста</h1>
          <span className="text-sm text-[var(--color-text-muted)]">заявки 1С: где можно сделать дешевле, чем продал менеджер</span>
          {q.isFetching && <Loader2 size={14} className="animate-spin self-center text-[var(--color-text-muted)]" />}
        </header>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SearchSelect ariaLabel="Филиал" options={REGION_OPTIONS} value={region} onChange={setRegion} allLabel="Все филиалы" className="min-w-0 sm:w-48" />
          <label className="flex min-w-0 items-center gap-1.5 text-sm text-[var(--color-text-muted)]">
            <span className="shrink-0">Сумма от</span>
            <input value={minDraft ? fmtInt(Number(minDraft.replace(/\D/g, '')) || 0) : ''} inputMode="numeric" aria-label="Сумма заявки от, ₽"
              onChange={e => setMinDraft(e.target.value.replace(/\D/g, ''))} placeholder="0" className={`${inputCls} w-32 text-right tabular-nums`} />
            <span className="shrink-0">₽</span>
          </label>
          <SearchMultiSelect ariaLabel="Статусы 1С" options={statusOptions} value={statuses} onChange={setStatuses}
            allLabel="Все статусы 1С" unitLabel="статуса" className="min-w-0 sm:w-56" />
          <label className="relative flex w-full min-w-0 items-center sm:w-auto sm:min-w-56 sm:flex-1 sm:max-w-xs">
            <Search size={14} className="pointer-events-none absolute left-3 text-[var(--color-text-muted)]" />
            <input value={goodsDraft} onChange={e => setGoodsDraft(e.target.value)} aria-label="Товар или группа"
              placeholder="Товар или группа: газобетон, D500…" className={`${inputCls} w-full pl-8`} />
          </label>
          <SearchSelect ariaLabel="Период" options={DAYS_OPTIONS} value={days} onChange={setDays} className="min-w-0 sm:w-44" />
          <label className="flex min-h-11 sm:min-h-9 cursor-pointer items-center gap-2 text-sm text-[var(--color-text)]">
            <input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} className="h-4 w-4" />
            Только взятые мной
          </label>
        </div>

        {readOnly && (
          <Banner>Статусы карточек пока не сохраняются — таблица канбана ещё не создана (миграция 261). Заявки смотреть можно.</Banner>
        )}
        {q.error && <Banner tone="error">{(q.error as Error).message}</Banner>}
        {move.error && <Banner tone="error">{(move.error as Error).message}</Banner>}

        {/* < lg: одна колонка за раз */}
        <div className="flex flex-wrap gap-2 lg:hidden" role="tablist" aria-label="Колонки">
          {COLUMNS.map(c => (
            <button key={c.key} type="button" role="tab" aria-selected={col === c.key} onClick={() => setCol(c.key)}
              className={`focus-ring min-h-11 rounded-full border px-3 text-sm ${col === c.key
                ? 'border-[var(--brand)] bg-[var(--brand)]/10 font-semibold text-[var(--color-text)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)]'}`}>
              {c.label} · {fmtInt(byCol[c.key].length)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid min-w-0 flex-1 grid-cols-1 gap-3 px-4 py-4 sm:px-6 lg:grid-cols-4">
        {COLUMNS.map(c => {
          const cards = byCol[c.key];
          const shown = c.key === 'pool' ? cards.slice(0, poolShown) : cards;
          const sum = cards.reduce((a, x) => a + (x.amount ?? 0), 0);
          return (
            <section key={c.key} aria-label={c.label}
              className={`${col === c.key ? 'flex' : 'hidden'} min-w-0 flex-col gap-2 rounded-xl bg-[var(--color-bg)] p-2 lg:flex`}>
              <div className="flex items-baseline justify-between gap-2 px-1">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--color-text)]">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.tone }} />{c.label}
                </h2>
                <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{fmtInt(cards.length)} · {fmtMlnRub(sum)}</span>
              </div>
              {q.isLoading && <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-[var(--color-text-muted)]" /></div>}
              {!q.isLoading && cards.length === 0 && (
                <div className="px-1 py-4 text-center text-xs text-[var(--color-text-muted)]">
                  {c.key === 'pool' ? 'Под фильтры ничего не попало' : 'Пусто'}
                </div>
              )}
              {shown.map(card => (
                <KanbanCard key={card.key} card={card} onOpen={() => setOpen(card)} actions={actionsFor(card)} />
              ))}
              {c.key === 'pool' && cards.length > shown.length && (
                <button type="button" onClick={() => setPoolShown(n => n + POOL_PAGE)}
                  className="focus-ring min-h-11 rounded-lg border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                  Показать ещё {fmtInt(Math.min(POOL_PAGE, cards.length - shown.length))} из {fmtInt(cards.length - shown.length)}
                </button>
              )}
            </section>
          );
        })}
      </div>

      {open && (
        <RequestCardPanel id={open.id} src={`/api/logist-kanban/requests/${open.id}`} section="Канбан логиста"
          onClose={() => setOpen(null)}
          actions={<div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
            <span className="text-sm text-[var(--color-text-muted)]">Канбан: <b className="text-[var(--color-text)]">{COLUMNS.find(c => c.key === open.board)?.label}</b>{open.owner ? ` · ${open.owner}` : ''}</span>
            <div className="ml-auto">{actionsFor(open)}</div>
          </div>} />
      )}
    </div>
  );
}

function Banner({ children, tone = 'warn' }: { children: React.ReactNode; tone?: 'warn' | 'error' }) {
  const cls = tone === 'error'
    ? 'border-[var(--color-negative)]/40 bg-[var(--color-negative)]/10 text-[var(--color-negative)]'
    : 'border-[var(--warning-text)]/30 bg-[var(--warning-bg)] text-[var(--color-text)]';
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] ${cls}`}>
      <AlertTriangle size={16} className="mt-px shrink-0" />{children}
    </div>
  );
}

function CardActions({ card, disabled, onMove }: { card: BoardCard; disabled: boolean; onMove: (s: CardStatus) => void }) {
  const btn = 'focus-ring inline-flex min-h-9 items-center gap-1 rounded-md border px-2 text-xs font-medium disabled:opacity-50 tap-target';
  const b = (s: CardStatus, label: string, icon: React.ReactNode, cls: string) => (
    <button key={s} type="button" disabled={disabled} className={`${btn} ${cls}`}
      onClick={e => { e.stopPropagation(); onMove(s); }}>{icon}{label}</button>
  );
  const neutral = 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-table-header)]';
  return (
    <div className="flex flex-wrap gap-1.5">
      {card.board === 'pool' && b('in_work', 'Взять в работу', <Play size={12} />, 'border-[var(--brand)] text-[var(--brand)] hover:bg-[var(--brand)]/10')}
      {card.board === 'in_work' && <>
        {b('success', 'Успешно', <Check size={12} />, 'border-[var(--color-positive)]/50 text-[var(--color-positive)] hover:bg-[var(--color-positive)]/10')}
        {b('fail', 'Не вышло', <X size={12} />, 'border-[var(--color-negative)]/50 text-[var(--color-negative)] hover:bg-[var(--color-negative)]/10')}
        {b('pool', 'Вернуть', <RotateCcw size={12} />, neutral)}
      </>}
      {(card.board === 'success' || card.board === 'fail') && b('in_work', 'Снова в работу', <RotateCcw size={12} />, neutral)}
    </div>
  );
}

function KanbanCard({ card, onOpen, actions }: { card: BoardCard; onOpen: () => void; actions: React.ReactNode }) {
  return (
    <article className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-[var(--color-text)]">
      <button type="button" onClick={onOpen} className="focus-ring flex min-w-0 flex-col gap-1 rounded-sm text-left">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate text-xs text-[var(--color-text-muted)]">№ {card.number} · {fmtDate(card.docDate)}</span>
          <span className="shrink-0 text-sm font-semibold tabular-nums">{fmtRub(card.amount)}</span>
        </div>
        <div className="truncate text-sm font-medium">{humanName(card.buyer) ?? 'Без покупателя'}</div>
        {card.goods.length > 0 && (
          <ul className="flex flex-col text-xs text-[var(--color-text-muted)]">
            {card.goods.map((g, i) => <li key={i} className="truncate">{g}</li>)}
            {card.linesN > card.goods.length && <li>ещё {fmtInt(card.linesN - card.goods.length)} поз.</li>}
          </ul>
        )}
        <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-xs text-[var(--color-text-muted)]">
          <span className="rounded bg-[var(--color-table-header)] px-1.5 py-px text-[var(--color-text)]">{card.status1c}</span>
          <span className="truncate">М: {humanName(card.manager) ?? '—'}</span>
          {card.logist && <span className="truncate">Л: {humanName(card.logist)}</span>}
          {card.region !== 'Без региона' && <span>{card.region}</span>}
        </div>
        {card.owner && card.board !== 'pool' && (
          <div className="text-xs text-[var(--color-text-muted)]">Взял: {card.owner}{card.updatedAt ? ` · ${fmtDate(card.updatedAt)}` : ''}</div>
        )}
      </button>
      {actions}
    </article>
  );
}
