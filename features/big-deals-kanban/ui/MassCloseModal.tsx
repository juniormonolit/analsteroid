'use client';
// Массовое закрытие задач канбана больших чеков (владелец 18.11: в «Не продано (проверка)» висят тысячи задач «ждёт
// контроля»). POST /api/big-deals-kanban/mass-close (engine/massClose.ts): предпросмотр (dryRun) → подтверждение с числом
// → фоновая job, прогресс опросом GET ?job=. Сервер сам режет до задач зоны пользователя, которыми он управляет.
// Здесь же ConfirmCloseModal — подтверждение необратимого закрытия (drag в «Не продано», «Не продано → завершить»).
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Modal } from '@/components/ui/Modal';
import { SearchSelect } from '@/components/ui/SearchSelect';
import type { BigFilters, BigMassCloseJob, BigTaskCard } from '../engine/types';
import { STATE_META, fmtD, plural, shortName } from './format';

const btn = 'inline-flex min-h-11 items-center justify-center rounded-md border border-[var(--color-border)] px-3 text-[13px] hover:bg-[var(--color-bg-hover)] disabled:opacity-50';
const danger = 'inline-flex min-h-11 items-center justify-center rounded-md bg-[var(--color-negative)] px-4 text-[13px] font-medium text-white disabled:opacity-50';
const input = 'w-full min-w-0 rounded-md border border-[var(--color-border)] bg-transparent px-2.5 py-2 text-base sm:text-sm';

const tasksWord = (n: number) => plural(n, 'задача', 'задачи', 'задач');
const tasksAcc = (n: number) => plural(n, 'задачу', 'задачи', 'задач');

/** Подтверждение необратимого закрытия задач в Битриксе. count — сколько задач закроется. */
export function ConfirmCloseModal({ count, onConfirm, onCancel, busy = false, title }: {
  count: number; onConfirm: () => void; onCancel: () => void; busy?: boolean;
  /** Заголовок окна (по умолчанию «Закрыть N задач?»). */
  title?: string;
}) {
  return (
    <Modal open onOpenChange={o => { if (!o && !busy) onCancel(); }} title={title ?? (count === 1 ? 'Закрыть задачу?' : `Закрыть ${count} ${tasksAcc(count)}?`)}>
      <div className="flex flex-col gap-3 text-[13px] text-[var(--color-text)]">
        <p>{count === 1 ? 'Задача будет закрыта' : `${count} ${tasksWord(count)} будут закрыты`} в Битриксе. Вернуть {count === 1 ? 'её' : 'их'} из канбана нельзя.</p>
        <p className="text-[12px] text-[var(--color-text-muted)]">Сделку это не закрывает. В чат задачи уйдёт комментарий с вашим именем.</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={btn} disabled={busy} onClick={onCancel}>Отмена</button>
          <button type="button" className={danger} disabled={busy} onClick={onConfirm}>{busy ? 'Закрываю…' : count === 1 ? 'Закрыть задачу' : `Закрыть ${count}`}</button>
        </div>
      </div>
    </Modal>
  );
}

export type MassCloseMode = { taskIds: number[] } | { filters: BigFilters; title: string };

interface Preview { count: number; matched: number; limited: boolean; skipped: number; sample: BigTaskCard[] }

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch('/api/big-deals-kanban/mass-close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
  return j as T;
}

const IDLE_OPTIONS = [0, 7, 14, 30, 60, 90].map(d => ({ value: String(d), label: d ? `не менялась ≥ ${d} дн.` : 'без ограничения по простою' }));
const STATE_OPTIONS = [{ value: 'control', label: 'только «ждёт контроля»' }, { value: 'any', label: 'любой открытый статус' }];

/**
 * Массовое закрытие: по выделению на доске ({ taskIds }) или по правилу ({ filters, title } — напр. колонка
 * «Не продано (проверка)»). В режиме правила можно поправить «не менялась ≥ N дней» и статус.
 * onDone — после окончания job (обновить доску).
 */
export function MassCloseModal({ mode, onClose, onDone }: { mode: MassCloseMode; onClose: () => void; onDone: () => void }) {
  const byRule = 'filters' in mode;
  const [idle, setIdle] = useState(() => String(byRule ? mode.filters.idleDaysMin ?? 30 : 0));
  const [stateMode, setStateMode] = useState<'control' | 'any'>(() => (byRule && mode.filters.states?.length === 1 && mode.filters.states[0] === 'control' ? 'control' : 'any'));
  const [comment, setComment] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const selector = useMemo<Record<string, unknown>>(() => {
    if (!byRule) return { taskIds: mode.taskIds };
    const states: BigFilters['states'] = stateMode === 'control' ? ['control'] : (mode.filters.states ?? []).filter(s => s !== 'done');
    return { filters: { ...mode.filters, idleDaysMin: Number(idle) || null, states: states.length ? states : undefined } };
  }, [byRule, mode, idle, stateMode]);

  const preview = useQuery<Preview>({
    queryKey: ['big-deals-mass-close-preview', selector],
    queryFn: () => post<Preview>({ ...selector, dryRun: true }),
    enabled: !jobId,
    staleTime: 15_000,
  });
  const job = useQuery<BigMassCloseJob>({
    queryKey: ['big-deals-mass-close-job', jobId],
    queryFn: async () => {
      const r = await fetch(`/api/big-deals-kanban/mass-close?job=${encodeURIComponent(jobId!)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j as BigMassCloseJob;
    },
    enabled: !!jobId,
    refetchInterval: q => (q.state.data?.finished ? false : 1000),
  });
  const finished = !!job.data?.finished;
  useEffect(() => { if (finished) onDone(); }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = preview.data?.count ?? 0;
  const start = async () => {
    setStarting(true); setStartErr(null);
    try {
      const r = await post<{ jobId: string }>({ ...selector, comment: comment.trim() || undefined, expectedCount: count });
      setJobId(r.jobId); setConfirm(false);
    } catch (e) { setStartErr(e instanceof Error ? e.message : String(e)); setConfirm(false); void preview.refetch(); }
    finally { setStarting(false); }
  };

  const running = !!jobId && !finished;
  const j = job.data;
  const pct = j && j.total ? Math.round(((j.done + j.failed) / j.total) * 100) : 0;
  const title = byRule ? `Закрыть задачи: ${mode.title}` : `Закрыть выбранные (${mode.taskIds.length})`;

  return (
    <>
    <Modal open={!confirm} onOpenChange={o => { if (!o) onClose(); }} desktopWidth="sm:max-w-xl sm:w-[94vw]" title={<span className="line-clamp-2 break-words">{title}</span>}>
      <div className="flex min-w-0 flex-col gap-3 text-[13px] text-[var(--color-text)]">
        {!jobId && byRule && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <SearchSelect options={IDLE_OPTIONS} value={idle} onChange={setIdle} ariaLabel="Не менялась дней" className="min-h-11 w-full" />
            <SearchSelect options={STATE_OPTIONS} value={stateMode} onChange={v => setStateMode(v === 'control' ? 'control' : 'any')} ariaLabel="Статус задачи" className="min-h-11 w-full" />
          </div>
        )}

        {!jobId && (
          <div className="flex flex-col gap-2">
            {preview.isLoading && <p className="text-[var(--color-text-muted)]">Считаю задачи…</p>}
            {preview.error && <p className="text-[var(--color-negative)]">{(preview.error as Error).message}</p>}
            {preview.data && (
              <>
                <p className="text-[15px]">
                  {count ? <>Закроется <b>{count}</b> {tasksWord(count)} вашей зоны.</> : 'Под условие не попала ни одна открытая задача вашей зоны.'}
                </p>
                {preview.data.limited && <p className="text-[12px] text-[var(--color-warning)]">Подошло {preview.data.matched} — за раз закрываем не больше {count}, начиная с самых давно не менявшихся. Остальные — следующим запуском.</p>}
                {preview.data.skipped > 0 && <p className="text-[12px] text-[var(--color-text-muted)]">{preview.data.skipped} из выбранных пропущены: уже закрыты или не в вашей зоне.</p>}
                {preview.data.sample.length > 0 && (
                  <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto rounded-md border border-[var(--color-border)] p-2">
                    {preview.data.sample.map(c => (
                      <li key={c.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12.5px]">
                        <a href={c.url} target="_blank" rel="noreferrer" className="min-w-0 break-words text-[var(--color-accent)] hover:underline">{c.title}</a>
                        <span className="text-[11.5px] text-[var(--color-text-muted)]">{c.groupShort} · {shortName(c.responsible.name)} · {STATE_META[c.state].label} · изм. {fmtD(c.changedAt ?? c.createdAt)}</span>
                      </li>
                    ))}
                    {count > preview.data.sample.length && <li className="text-[12px] text-[var(--color-text-muted)]">…и ещё {count - preview.data.sample.length}</li>}
                  </ul>
                )}
              </>
            )}
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} maxLength={2000}
              placeholder="Комментарий в каждую задачу (необязательно) — к «Закрыто массово из канбана…»" className={input} />
            <p className="text-[12px] text-[var(--color-text-muted)]">Закрывается служебной учёткой Битрикса (в истории задач — админ), в комментарии — ваше имя. Сделки не закрываются.</p>
            {startErr && <p className="text-[var(--color-negative)]">{startErr}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={btn} onClick={onClose}>Отмена</button>
              <button type="button" className={danger} disabled={!count || preview.isFetching || starting} onClick={() => setConfirm(true)}>
                {count ? `Закрыть ${count} ${tasksAcc(count)}` : 'Закрыть'}
              </button>
            </div>
          </div>
        )}

        {jobId && (
          <div className="flex flex-col gap-2">
            {job.error && <p className="text-[var(--color-negative)]">{(job.error as Error).message}</p>}
            {j && (
              <>
                <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-bg-hover)]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full bg-[var(--color-accent)] transition-[width]" style={{ width: `${pct}%` }} />
                </div>
                <p>{j.finished ? 'Готово.' : 'Закрываю…'} Закрыто <b>{j.done}</b> из {j.total}{j.failed ? <>, ошибок <b className="text-[var(--color-negative)]">{j.failed}</b></> : ''}.</p>
                {!j.finished && <p className="text-[12px] text-[var(--color-text-muted)]">Окно можно закрыть — закрытие продолжится на сервере.</p>}
                {j.errors.length > 0 && (
                  <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-md border border-[var(--color-border)] p-2 text-[12px] text-[var(--color-text-secondary)]">
                    {j.errors.map((e, i) => <li key={i} className="break-words">{e}</li>)}
                  </ul>
                )}
              </>
            )}
            <div className="flex justify-end">
              <button type="button" className={btn} onClick={onClose}>{finished ? 'Готово' : 'Свернуть'}</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
    {confirm && <ConfirmCloseModal count={count} busy={starting} onConfirm={() => void start()} onCancel={() => setConfirm(false)} />}
    </>
  );
}
