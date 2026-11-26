'use client';
// Закрытое время тренера (миграция 299): форма «Закрыть запись» и список закрытий. Используется во
// «Обучения → Настройки» и в сетке недели (кнопка «Закрыть время»).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Trash2 } from 'lucide-react';
import type { TrainingClosure } from '../types';
import { CLOSURES_KEY, createClosure, deleteClosure, fetchClosures, QUEUE_KEY } from './api';
import { addDaysKey, ddmm, mskDateKey, mskTime } from './format';

const INPUT = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base sm:text-sm outline-none focus:border-[var(--color-accent)]';
const LABEL = 'flex min-w-0 flex-col gap-1 text-[12.5px] text-[var(--color-text-secondary)]';

/** «27.11 весь день», «27.11–29.11», «27.11 14:00–16:00» (МСК). */
export function closureWhen(c: TrainingClosure): string {
  if (c.allDay) {
    const first = mskDateKey(c.startsAt);
    const last = addDaysKey(mskDateKey(c.endsAt), -1);
    return first === last ? `${ddmm(first)} весь день` : `${ddmm(first)}–${ddmm(last)}`;
  }
  return `${ddmm(mskDateKey(c.startsAt))} ${mskTime(c.startsAt)}–${mskTime(c.endsAt)}`;
}

/** Закрытия, пересекающие интервал. */
export const closuresAt = (list: TrainingClosure[], startMs: number, endMs: number) =>
  list.filter(c => Date.parse(c.startsAt) < endMs && startMs < Date.parse(c.endsAt));

export function ClosureForm({ initialDate, onDone }: { initialDate?: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const today = mskDateKey(new Date());
  const [date, setDate] = useState(initialDate && initialDate >= today ? initialDate : today);
  const [dateTo, setDateTo] = useState('');
  const [wholeDay, setWholeDay] = useState(true);
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('18:00');
  const [reason, setReason] = useState('');
  const mut = useMutation({
    mutationFn: () => createClosure(wholeDay
      ? { date, dateTo: dateTo && dateTo > date ? dateTo : null, reason }
      : { date, timeFrom: from, timeTo: to, reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CLOSURES_KEY });
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
      setReason('');
      onDone?.();
    },
  });
  return (
    <form className="flex min-w-0 flex-col gap-3 text-sm" onSubmit={e => { e.preventDefault(); mut.mutate(); }}>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={LABEL}>Дата<input type="date" className={INPUT} value={date} min={today} onChange={e => setDate(e.target.value)} required /></label>
        {wholeDay && (
          <label className={LABEL}>По какую дату (необязательно)<input type="date" className={INPUT} value={dateTo} min={date} onChange={e => setDateTo(e.target.value)} /></label>
        )}
      </div>
      <label className="inline-flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={wholeDay} onChange={e => setWholeDay(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
        Весь день
      </label>
      {!wholeDay && (
        <div className="grid min-w-0 grid-cols-2 gap-3">
          <label className={LABEL}>С (МСК)<input type="time" step={300} className={INPUT} value={from} onChange={e => setFrom(e.target.value)} required /></label>
          <label className={LABEL}>По (МСК)<input type="time" step={300} className={INPUT} value={to} onChange={e => setTo(e.target.value)} required /></label>
        </div>
      )}
      <label className={LABEL}>Причина (необязательно)
        <input className={INPUT} value={reason} maxLength={200} placeholder="Отпуск, выездное обучение…" onChange={e => setReason(e.target.value)} />
      </label>
      <p className="text-[12.5px] text-[var(--color-text-muted)]">
        В закрытое время нельзя поставить задачу «Теория», записать на занятие и собрать группу; подсказка слота его пропускает.
        Уже стоящие занятия не отменяются.
      </p>
      {mut.isError && <p className="text-[13px] text-[var(--color-negative)]">{(mut.error as Error).message}</p>}
      <div className="flex justify-end">
        <button type="submit" disabled={mut.isPending}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 font-medium text-white disabled:opacity-50">
          <Ban size={15} /> {mut.isPending ? 'Закрываю…' : 'Закрыть запись'}
        </button>
      </div>
    </form>
  );
}

/** Список закрытий с кнопкой «Открыть» (тренеру). */
export function ClosureList({ closures, canManage, empty }: { closures: TrainingClosure[]; canManage: boolean; empty?: string }) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (id: number) => deleteClosure(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: CLOSURES_KEY }); qc.invalidateQueries({ queryKey: QUEUE_KEY }); },
  });
  if (!closures.length) return empty ? <p className="text-[13px] text-[var(--color-text-muted)]">{empty}</p> : null;
  return (
    <ul className="flex min-w-0 flex-col gap-1.5">
      {closures.map(c => (
        <li key={c.id} className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--color-bg-hover)] px-3 py-1.5 text-[13px]">
          <Ban size={14} className="shrink-0 text-[var(--color-text-muted)]" />
          <span className="min-w-0 flex-1"><b className="tabular-nums">{closureWhen(c)}</b>{c.reason ? <span className="text-[var(--color-text-secondary)]"> · {c.reason}</span> : null}</span>
          {canManage && (
            <button type="button" onClick={() => del.mutate(c.id)} disabled={del.isPending} aria-label={`Открыть запись: ${closureWhen(c)}`}
              className="tap-target inline-flex shrink-0 items-center gap-1 text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-negative)]">
              <Trash2 size={13} /> <span className="hidden sm:inline">Открыть</span>
            </button>
          )}
        </li>
      ))}
      {del.isError && <li className="text-[13px] text-[var(--color-negative)]">{(del.error as Error).message}</li>}
    </ul>
  );
}

/** Блок для «Настроек»: форма + ближайшие закрытия (120 дней). */
export function ClosuresSettings() {
  const today = mskDateKey(new Date());
  const q = useQuery({ queryKey: [...CLOSURES_KEY, 'settings', today], queryFn: () => fetchClosures(today, addDaysKey(today, 120)) });
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-xl border border-[var(--color-border)] p-3">
      <legend className="px-1 text-[13px] font-medium">Закрыть запись</legend>
      <ClosureForm />
      <div className="flex min-w-0 flex-col gap-1.5 border-t border-[var(--color-border)] pt-3">
        <span className="text-[12.5px] text-[var(--color-text-secondary)]">Закрыто впереди</span>
        {q.isError ? <p className="text-[13px] text-[var(--color-negative)]">{(q.error as Error).message}</p>
          : <ClosureList closures={q.data?.closures ?? []} canManage={!!q.data?.canManage} empty={q.isLoading ? 'Загружаю…' : 'Ничего не закрыто'} />}
      </div>
    </fieldset>
  );
}
