'use client';

import { useMemo, useState } from 'react';
import { ExternalLink, Pause, Play, RotateCcw, Search, X, XCircle } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import {
  DISMISSAL_KINDS, DISMISSAL_KIND_LABELS, PASSWORD_RESET_BITRIX_ID,
  type DismissalAction, type DismissalItem, type DismissalItemStatus, type DismissalKind, type DismissalRunDetail,
} from '../types';
import { useRunCommand, type RunCommand } from './api';
import { fmtDateTime, fmtNum, plural } from './planMath';
import { ErrorBox, ITEM_STATUS_LABELS, ItemStatusBadge, btnDanger, btnPrimary, btnSecondary, card } from './shared';

// Исполнение прогона (queued/running/paused/done/failed/cancelled): прогресс, управление,
// завершающие шаги, итог по получателям, строки с фильтром (в URL: ?status=error&kind=…).

const PAGE = 100;
type Tally = Record<DismissalItemStatus, number> & { total: number };
const emptyTally = (): Tally => ({ pending: 0, done: 0, skipped: 0, error: 0, total: 0 });
const FOLLOW_KINDS: DismissalKind[] = ['task_deal', 'activity_deal'];
const DEAL_KINDS: DismissalKind[] = ['deal_primary', 'deal_repeat'];

/** Действие строки: будущее — пока ждёт, прошедшее — когда сделано. */
function actionText(it: DismissalItem, nameOf: (id: number) => string): string | null {
  const a: DismissalAction | null = it.action;
  if (!a) return null;
  const done = it.status === 'done';
  const to = it.target ? ` → ${nameOf(it.target)}` : '';
  switch (a) {
    case 'transfer': return `${done ? 'Передано' : 'Передать'}${to}`;
    case 'follow': return `${done ? 'Ушло за сделкой' : 'Вслед за сделкой'}${to}`;
    case 'brak': return done ? 'В автобраке' : 'В автобрак';
    case 'close': return done ? 'Закрыто' : 'Закрыть';
    case 'remove': return done ? 'Убран из участников' : 'Убрать из участников';
    case 'skip': return 'Не трогаем';
  }
}

export function RunProgress({ run }: { run: DismissalRunDetail }) {
  const cmd = useRunCommand(run.id);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [, setStatusFilter] = useUrlState('status', stringParam(''));
  const c = run.counts;
  const processed = c.done + c.skipped + c.error;
  const pct = c.total ? Math.round((processed / c.total) * 100) : 0;
  const active = run.status === 'queued' || run.status === 'running';
  const finished = run.status === 'done' || run.status === 'cancelled' || run.status === 'failed';
  const finalsErrors = run.finals ? Number(run.finals.ropMessage.status === 'error') + Number(run.finals.passwordReset.status === 'error') : 0;
  const canRetry = (c.error > 0 || finalsErrors > 0) && ['done', 'paused', 'failed'].includes(run.status) && !!run.startedAt;
  const nameOf = (id: number) => run.userNames?.[id] ?? `#${id}`;

  const byKind = useMemo(() => {
    const m = new Map<DismissalKind, Tally>();
    for (const it of run.items) {
      const t = m.get(it.kind) ?? emptyTally();
      t[it.status]++; t.total++;
      m.set(it.kind, t);
    }
    return m;
  }, [run.items]);

  // ETA: средний шаг по doneAt последних ~20 обработанных строк.
  const eta = useMemo(() => {
    if (!active || !c.pending) return null;
    const times = run.items.map(i => i.doneAt ? Date.parse(i.doneAt) : NaN).filter(Number.isFinite).sort((a, b) => a - b).slice(-20);
    if (times.length < 3) return null;
    const step = (times[times.length - 1] - times[0]) / (times.length - 1);
    if (!(step > 0)) return null;
    return Math.max(1, Math.round((step * c.pending) / 60000));
  }, [active, c.pending, run.items]);

  const pendingKinds = DISMISSAL_KINDS.filter(k => (byKind.get(k)?.pending ?? 0) > 0);
  const nowKind = active ? pendingKinds[0] : undefined;
  const onlyFollowLeft = active && pendingKinds.length > 0 && pendingKinds.every(k => FOLLOW_KINDS.includes(k));

  const exec = (x: RunCommand) => cmd.mutate(x, {
    onSuccess: () => {
      if (x === 'pause') setPauseRequested(true);
      if (x === 'resume') setPauseRequested(false);
      if (x === 'retry') setStatusFilter('');
    },
  });

  return (
    <>
      <div className={`${card} mb-3 flex flex-col gap-3 p-3 sm:p-4`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="text-sm text-[var(--color-text)] tabular-nums">
            Обработано <b>{fmtNum(processed)}</b> из <b>{fmtNum(c.total)}</b> · {pct}%
            {eta != null && <span className="text-[var(--color-text-muted)]"> · ≈ {eta} мин осталось</span>}
          </div>
          <div className="flex flex-wrap gap-x-3 text-xs tabular-nums text-[var(--color-text-muted)]">
            <span className="text-[var(--color-positive)]">сделано <b>{fmtNum(c.done)}</b></span>
            <span>пропущено <b>{fmtNum(c.skipped)}</b></span>
            <span className={c.error ? 'text-[var(--color-negative)]' : ''}>ошибок <b>{fmtNum(c.error)}</b></span>
            <span>{run.status === 'cancelled' ? 'не выполнено' : 'ждёт'} <b>{fmtNum(c.pending)}</b></span>
          </div>
        </div>
        <ProgressBar t={{ done: c.done, skipped: c.skipped, error: c.error, pending: c.pending, total: c.total }} />
        <div className="flex flex-col gap-0.5 text-xs text-[var(--color-text-muted)]">
          {nowKind && !onlyFollowLeft && <span>Сейчас: <b className="text-[var(--color-text)]">{DISMISSAL_KIND_LABELS[nowKind]}</b></span>}
          {onlyFollowLeft && <span>Ждём, пока Битрикс доработает смену ответственного у сделок (до 1,5 мин) — потом передадим задачи и дела по ним.</span>}
          {active && pauseRequested && <span className="text-[var(--color-warning)]">Остановится после текущей записи.</span>}
          {active && !pauseRequested && <span>Исполнитель идёт по одной записи — страницу можно закрыть, работа продолжится.</span>}
          {run.status === 'paused' && <span>На паузе — нажмите «Продолжить», чтобы доделать оставшееся.</span>}
          <span className="flex flex-wrap gap-x-4">
            {run.startedAt && <span>запущен {fmtDateTime(run.startedAt)}</span>}
            {run.finishedAt && <span>завершён {fmtDateTime(run.finishedAt)}</span>}
          </span>
        </div>
        {run.error && <ErrorBox>{run.error}</ErrorBox>}
        <div className="flex flex-wrap gap-2">
          {active && (
            <button type="button" className={btnSecondary} disabled={cmd.isPending || pauseRequested} onClick={() => exec('pause')}>
              <Pause size={14} /> Пауза
            </button>
          )}
          {run.status === 'paused' && (
            <button type="button" className={btnPrimary} disabled={cmd.isPending} onClick={() => exec('resume')}>
              <Play size={14} /> Продолжить
            </button>
          )}
          {(active || run.status === 'paused') && (
            <button type="button" className={btnDanger} disabled={cmd.isPending} onClick={() => setConfirmCancel(true)}>
              <XCircle size={14} /> Остановить
            </button>
          )}
          {canRetry && (
            <button type="button" className={btnSecondary} disabled={cmd.isPending} onClick={() => exec('retry')}>
              <RotateCcw size={14} /> Повторить ошибки ({fmtNum(c.error + finalsErrors)})
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
            <div key={k} className="flex flex-col gap-1.5 px-3 py-2.5 sm:px-4 lg:flex-row lg:items-center lg:gap-4">
              <div className="text-sm text-[var(--color-text)] lg:w-[260px] lg:shrink-0">{DISMISSAL_KIND_LABELS[k]}</div>
              <div className="min-w-0 flex-1"><ProgressBar t={t} thin /></div>
              <div className="flex flex-wrap gap-x-3 text-xs tabular-nums text-[var(--color-text-muted)] lg:w-[220px] lg:shrink-0 lg:justify-end">
                <span><b className="text-[var(--color-text)]">{fmtNum(t.done)}</b> / {fmtNum(t.total)}</span>
                {t.skipped > 0 && <span>пропущено {fmtNum(t.skipped)}</span>}
                {t.error > 0 && <span className="text-[var(--color-negative)]">ошибок {fmtNum(t.error)}</span>}
              </div>
            </div>
          );
        })}
      </div>

      <FinalsBlock run={run} />

      {(run.status === 'done' || run.status === 'cancelled') && <RecipientsSummary run={run} nameOf={nameOf} />}

      <ItemsList run={run} nameOf={nameOf} finished={finished} />

      <ConfirmDialog
        open={confirmCancel}
        title="Остановить прогон?"
        description={'Оставшиеся строки не будут выполнены.\nУже сделанное в Битриксе не откатывается.'}
        confirmLabel="Остановить" cancelLabel="Продолжить работу" tone="danger"
        pending={cmd.isPending}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => cmd.mutate('cancel', { onSettled: () => setConfirmCancel(false) })}
      />
    </>
  );
}

/** Завершающие шаги: сообщение РОПу и задача сменить пароль. */
function FinalsBlock({ run }: { run: DismissalRunDetail }) {
  const f = run.finals;
  if (!f) return null;
  const ropName = run.rop?.name ?? (run.plan?.ropBitrixId ? run.userNames?.[run.plan.ropBitrixId] : null);
  const kuznetsova = run.userNames?.[PASSWORD_RESET_BITRIX_ID] ?? 'Анна Кузнецова';
  const taskUrl = f.passwordReset.taskUrl ?? null;
  const detailCls = (s: string) => `text-xs break-words ${s === 'error' ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`;
  return (
    <div className={`${card} mb-3 divide-y divide-[var(--color-border)]`}>
      <div className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-[var(--color-text)]">Сообщение РОПу{ropName && <> · {ropName}</>}</div>
          {f.ropMessage.detail && <div className={detailCls(f.ropMessage.status)}>{f.ropMessage.detail}</div>}
        </div>
        <ItemStatusBadge status={f.ropMessage.status} />
      </div>
      <div className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-[var(--color-text)] break-words">Задача сменить пароль · {kuznetsova}</div>
          {taskUrl && (
            <a href={taskUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1 text-xs text-[var(--color-accent)] hover:underline sm:min-h-0">
              Задача{f.passwordReset.taskId ? ` #${f.passwordReset.taskId}` : ''} <ExternalLink size={12} />
            </a>
          )}
          {f.passwordReset.detail && <div className={detailCls(f.passwordReset.status)}>{f.passwordReset.detail}</div>}
        </div>
        <ItemStatusBadge status={f.passwordReset.status} />
      </div>
    </div>
  );
}

/** Итог по получателям (после завершения): кому сколько сделок и задач/дел ушло. */
function RecipientsSummary({ run, nameOf }: { run: DismissalRunDetail; nameOf: (id: number) => string }) {
  const { rows, brak, closed } = useMemo(() => {
    const m = new Map<number, { deals: number; tasks: number }>();
    let brak = 0, closed = 0;
    for (const it of run.items) {
      if (it.status !== 'done') continue;
      if (it.action === 'brak') { brak++; continue; }
      if (it.action === 'close') { closed++; continue; }
      if ((it.action === 'transfer' || it.action === 'follow') && it.target) {
        const e = m.get(it.target) ?? { deals: 0, tasks: 0 };
        if (DEAL_KINDS.includes(it.kind)) e.deals++; else e.tasks++;
        m.set(it.target, e);
      }
    }
    return { rows: [...m.entries()].sort((a, b) => b[1].deals - a[1].deals || b[1].tasks - a[1].tasks), brak, closed };
  }, [run.items]);
  if (!rows.length && !brak && !closed) return null;
  const th = 'px-2 py-1.5 text-xs font-medium text-[var(--color-text-muted)]';
  return (
    <section className={`${card} mb-3 p-3 sm:p-4`}>
      <h2 className="mb-2 text-sm font-semibold text-[var(--color-text)]">Итог: кому что ушло</h2>
      {rows.length > 0 && (
        <div className="scroll-x rounded-lg border border-[var(--color-border)]">
          <table className="w-full min-w-[360px] text-sm tabular-nums">
            <thead className="bg-[var(--color-table-header)]">
              <tr><th className={`${th} text-left`}>Получатель</th><th className={`${th} text-right`}>сделок</th><th className={`${th} text-right`}>задач и дел</th></tr>
            </thead>
            <tbody>
              {rows.map(([id, e]) => (
                <tr key={id} className="border-t border-[var(--color-table-row-border)]">
                  <td className="px-2 py-1.5">{nameOf(id)}</td>
                  <td className="px-2 py-1.5 text-right">{fmtNum(e.deals)}</td>
                  <td className="px-2 py-1.5 text-right">{fmtNum(e.tasks)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(brak > 0 || closed > 0) && (
        <p className="mt-2 flex flex-wrap gap-x-4 text-sm tabular-nums">
          {brak > 0 && <span className="text-[var(--color-warning)]">в автобрак <b>{fmtNum(brak)}</b></span>}
          {closed > 0 && <span>закрыто <b>{fmtNum(closed)}</b></span>}
        </p>
      )}
    </section>
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

function ItemsList({ run, nameOf, finished }: { run: DismissalRunDetail; nameOf: (id: number) => string; finished: boolean }) {
  const [status, setStatus] = useUrlState('status', stringParam(''));
  const [kind, setKind] = useUrlState('kind', stringParam(''));
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const cancelled = run.status === 'cancelled';

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return run.items.filter(it =>
      (!status || it.status === status) && (!kind || it.kind === kind) &&
      (!needle || `${it.title} ${it.detail ?? ''} ${it.entityId}`.toLowerCase().includes(needle)));
  }, [run.items, status, kind, q]);

  const statusCounts: Record<DismissalItemStatus, number> = { pending: run.counts.pending, done: run.counts.done, skipped: run.counts.skipped, error: run.counts.error };
  const statusOptions = (Object.keys(ITEM_STATUS_LABELS) as DismissalItemStatus[])
    .filter(s => statusCounts[s] > 0 || s === status)
    .map(s => ({ value: s, label: `${cancelled && s === 'pending' ? 'Не выполнено' : ITEM_STATUS_LABELS[s]} · ${fmtNum(statusCounts[s])}` }));
  const kindOptions = DISMISSAL_KINDS.filter(k => run.items.some(i => i.kind === k)).map(k => ({ value: k, label: DISMISSAL_KIND_LABELS[k] }));

  return (
    <section className={card}>
      {finished && run.counts.error > 0 && (
        <p className="border-b border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-muted)] sm:px-4">
          {fmtNum(run.counts.error)} {plural(run.counts.error, ['строка', 'строки', 'строк'])} с ошибкой. Чаще всего это нет прав или запись уже изменили
          в Битриксе руками. Откройте запись по ссылке, при необходимости поправьте и нажмите «Повторить ошибки» — сделанное повторно не тронется.
        </p>
      )}
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
        {filtered.slice(0, limit).map(it => {
          const act = actionText(it, nameOf);
          return (
            <li key={it.key} className="flex items-start gap-3 px-3 py-2 sm:px-4">
              <div className="min-w-0 flex-1">
                {it.url ? (
                  <a href={it.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 text-sm text-[var(--color-accent)] hover:underline">
                    <span className="min-w-0 break-words">{it.title || `#${it.entityId}`}</span>
                    <ExternalLink size={12} className="shrink-0" />
                  </a>
                ) : <span className="text-sm text-[var(--color-text)] break-words">{it.title || `#${it.entityId}`}</span>}
                <div className="text-xs text-[var(--color-text-muted)] break-words">
                  {DISMISSAL_KIND_LABELS[it.kind]}{act && <> · {act}</>}{it.doneAt && <> · {fmtDateTime(it.doneAt)}</>}
                </div>
                {it.detail && (
                  <div className={`mt-0.5 text-xs break-words ${it.status === 'error' ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`}>{it.detail}</div>
                )}
              </div>
              <ItemStatusBadge status={it.status} cancelled={cancelled} />
            </li>
          );
        })}
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
