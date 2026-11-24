'use client';

import { useMemo, useState } from 'react';
import { ExternalLink, Pause, Play, RotateCcw, Search, X, XCircle } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SearchSelect } from '@/components/ui/SearchSelect';
import {
  DISMISSAL_ACTION_LABELS, DISMISSAL_KINDS, DISMISSAL_KIND_LABELS,
  type DismissalItemStatus, type DismissalKind, type DismissalRunDetail,
} from '../types';
import { useRunCommand, type RunCommand } from './api';
import { fmtDateTime, fmtNum } from './planMath';
import { ErrorBox, ITEM_STATUS_LABELS, ItemStatusBadge, btnDanger, btnPrimary, btnSecondary, card } from './shared';

// Исполнение прогона (queued/running/paused/done/failed/cancelled): прогресс, управление, строки.

const PAGE = 100;
type Tally = Record<DismissalItemStatus, number> & { total: number };
const emptyTally = (): Tally => ({ pending: 0, done: 0, skipped: 0, error: 0, total: 0 });

export function RunProgress({ run }: { run: DismissalRunDetail }) {
  const cmd = useRunCommand(run.id);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const c = run.counts;
  const processed = c.done + c.skipped + c.error;
  const pct = c.total ? Math.round((processed / c.total) * 100) : 0;
  const active = run.status === 'queued' || run.status === 'running';

  const byKind = useMemo(() => {
    const m = new Map<DismissalKind, Tally>();
    for (const it of run.items) {
      const t = m.get(it.kind) ?? emptyTally();
      t[it.status]++; t.total++;
      m.set(it.kind, t);
    }
    return m;
  }, [run.items]);

  const run_ = (x: RunCommand) => cmd.mutate(x);

  return (
    <>
      <div className={`${card} mb-3 flex flex-col gap-3 p-3 sm:p-4`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="text-sm text-[var(--color-text)] tabular-nums">
            Обработано <b>{fmtNum(processed)}</b> из <b>{fmtNum(c.total)}</b> · {pct}%
          </div>
          <div className="flex flex-wrap gap-x-3 text-xs tabular-nums text-[var(--color-text-muted)]">
            <span className="text-[var(--color-positive)]">сделано <b>{fmtNum(c.done)}</b></span>
            <span>пропущено <b>{fmtNum(c.skipped)}</b></span>
            <span className={c.error ? 'text-[var(--color-negative)]' : ''}>ошибок <b>{fmtNum(c.error)}</b></span>
            <span>ждёт <b>{fmtNum(c.pending)}</b></span>
          </div>
        </div>
        <ProgressBar t={{ done: c.done, skipped: c.skipped, error: c.error, pending: c.pending, total: c.total }} />
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[var(--color-text-muted)]">
          {run.startedAt && <span>запущен {fmtDateTime(run.startedAt)}</span>}
          {run.finishedAt && <span>завершён {fmtDateTime(run.finishedAt)}</span>}
          {active && <span>исполнитель идёт по одной записи — страницу можно закрыть, работа продолжится</span>}
          {run.status === 'paused' && <span>на паузе — нажмите «Продолжить», чтобы доделать оставшееся</span>}
        </div>
        {run.error && <ErrorBox>{run.error}</ErrorBox>}
        <div className="flex flex-wrap gap-2">
          {active && (
            <button type="button" className={btnSecondary} disabled={cmd.isPending} onClick={() => run_('pause')}>
              <Pause size={14} /> Пауза
            </button>
          )}
          {run.status === 'paused' && (
            <button type="button" className={btnPrimary} disabled={cmd.isPending} onClick={() => run_('resume')}>
              <Play size={14} /> Продолжить
            </button>
          )}
          {(active || run.status === 'paused') && (
            <button type="button" className={btnDanger} disabled={cmd.isPending} onClick={() => setConfirmCancel(true)}>
              <XCircle size={14} /> Отменить
            </button>
          )}
          {c.error > 0 && !active && (
            <button type="button" className={btnSecondary} disabled={cmd.isPending} onClick={() => run_('retry')}>
              <RotateCcw size={14} /> Повторить ошибки ({fmtNum(c.error)})
            </button>
          )}
        </div>
        {cmd.isError && <ErrorBox>{cmd.error.message}</ErrorBox>}
        {run.plan?.note && <p className="text-xs text-[var(--color-text-muted)] break-words">Комментарий: {run.plan.note}</p>}
      </div>

      <div className={`${card} mb-3 divide-y divide-[var(--color-border)]`}>
        {DISMISSAL_KINDS.filter(k => byKind.has(k)).map(k => {
          const t = byKind.get(k)!;
          return (
            <div key={k} className="flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4 sm:px-4">
              <div className="text-sm text-[var(--color-text)] sm:w-[260px] sm:shrink-0">{DISMISSAL_KIND_LABELS[k]}</div>
              <div className="min-w-0 flex-1"><ProgressBar t={t} thin /></div>
              <div className="flex flex-wrap gap-x-3 text-xs tabular-nums text-[var(--color-text-muted)] sm:w-[220px] sm:shrink-0 sm:justify-end">
                <span><b className="text-[var(--color-text)]">{fmtNum(t.done)}</b> / {fmtNum(t.total)}</span>
                {t.skipped > 0 && <span>пропущено {fmtNum(t.skipped)}</span>}
                {t.error > 0 && <span className="text-[var(--color-negative)]">ошибок {fmtNum(t.error)}</span>}
              </div>
            </div>
          );
        })}
      </div>

      <ItemsList run={run} />

      <ConfirmDialog
        open={confirmCancel}
        title="Отменить увольнение?"
        description={'Оставшиеся строки не будут выполнены.\nУже сделанное в Битриксе не откатывается.'}
        confirmLabel="Отменить прогон" cancelLabel="Не отменять" tone="danger"
        pending={cmd.isPending}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => cmd.mutate('cancel', { onSettled: () => setConfirmCancel(false) })}
      />
    </>
  );
}

function ProgressBar({ t, thin }: { t: Tally; thin?: boolean }) {
  const w = (n: number) => (t.total ? `${(n / t.total) * 100}%` : '0%');
  return (
    <div className={`flex w-full overflow-hidden rounded-full bg-[var(--color-bg-hover)] ${thin ? 'h-1.5' : 'h-2.5'}`}
      role="progressbar" aria-valuemin={0} aria-valuemax={t.total} aria-valuenow={t.done + t.skipped + t.error}>
      <div className="h-full bg-[var(--color-positive)] transition-[width] duration-500" style={{ width: w(t.done) }} />
      <div className="h-full bg-[var(--color-border-strong)] transition-[width] duration-500" style={{ width: w(t.skipped) }} />
      <div className="h-full bg-[var(--color-negative)] transition-[width] duration-500" style={{ width: w(t.error) }} />
    </div>
  );
}

function ItemsList({ run }: { run: DismissalRunDetail }) {
  const [status, setStatus] = useState<string>(run.counts.error > 0 ? 'error' : '');
  const [kind, setKind] = useState<string>('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const nameOf = (id: number) => run.userNames?.[id] ?? `#${id}`;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return run.items.filter(it =>
      (!status || it.status === status) && (!kind || it.kind === kind) &&
      (!needle || `${it.title} ${it.subtitle ?? ''} ${it.detail ?? ''} ${it.entityId}`.toLowerCase().includes(needle)));
  }, [run.items, status, kind, q]);

  const statusCounts: Record<DismissalItemStatus, number> = { pending: run.counts.pending, done: run.counts.done, skipped: run.counts.skipped, error: run.counts.error };
  const statusOptions = (Object.keys(ITEM_STATUS_LABELS) as DismissalItemStatus[]).map(s => ({ value: s, label: `${ITEM_STATUS_LABELS[s]} · ${fmtNum(statusCounts[s])}` }));
  const kindOptions = DISMISSAL_KINDS.filter(k => run.items.some(i => i.kind === k)).map(k => ({ value: k, label: DISMISSAL_KIND_LABELS[k] }));

  return (
    <section className={card}>
      <div className="flex flex-col gap-2 border-b border-[var(--color-border)] p-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-4">
        <h2 className="text-sm font-semibold text-[var(--color-text)] sm:mr-2">Строки</h2>
        <SearchSelect options={statusOptions} value={status} onChange={v => { setStatus(v); setLimit(PAGE); }} allLabel={`Все статусы · ${fmtNum(run.counts.total)}`}
          ariaLabel="Фильтр по статусу" className="w-full sm:w-[200px]" />
        <SearchSelect options={kindOptions} value={kind} onChange={v => { setKind(v); setLimit(PAGE); }} allLabel="Все виды"
          ariaLabel="Фильтр по виду" className="w-full sm:w-[240px]" />
        <label className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 sm:w-[260px]">
          <Search size={14} className="shrink-0 text-[var(--color-text-muted)]" />
          <input value={q} onChange={e => { setQ(e.target.value); setLimit(PAGE); }} placeholder="Поиск"
            className="min-w-0 flex-1 bg-transparent text-base text-[var(--color-text)] outline-none sm:text-sm" />
          {q && <button type="button" onClick={() => setQ('')} aria-label="Очистить поиск" className="tap-target text-[var(--color-text-muted)]"><X size={14} /></button>}
        </label>
      </div>
      <ul className="divide-y divide-[var(--color-border)]">
        {filtered.slice(0, limit).map(it => (
          <li key={it.key} className="flex items-start gap-3 px-3 py-2 sm:px-4">
            <div className="min-w-0 flex-1">
              {it.url ? (
                <a href={it.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 text-sm text-[var(--color-accent)] hover:underline">
                  <span className="min-w-0 break-words">{it.title || `#${it.entityId}`}</span>
                  <ExternalLink size={12} className="shrink-0" />
                </a>
              ) : <span className="text-sm text-[var(--color-text)] break-words">{it.title || `#${it.entityId}`}</span>}
              <div className="text-xs text-[var(--color-text-muted)] break-words">
                {DISMISSAL_KIND_LABELS[it.kind]}
                {it.action && <> · {DISMISSAL_ACTION_LABELS[it.action]}{it.action === 'transfer' && it.target ? ` → ${nameOf(it.target)}` : ''}</>}
                {it.doneAt && <> · {fmtDateTime(it.doneAt)}</>}
              </div>
              {it.detail && (
                <div className={`mt-0.5 text-xs break-words ${it.status === 'error' ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`}>{it.detail}</div>
              )}
            </div>
            <ItemStatusBadge status={it.status} />
          </li>
        ))}
      </ul>
      {filtered.length === 0 && <div className="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">Строк с таким фильтром нет</div>}
      {filtered.length > limit && (
        <button type="button" onClick={() => setLimit(l => l + PAGE * 2)}
          className="flex min-h-11 w-full items-center justify-center border-t border-[var(--color-border)] text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
          Показать ещё (осталось {fmtNum(filtered.length - limit)})
        </button>
      )}
    </section>
  );
}
