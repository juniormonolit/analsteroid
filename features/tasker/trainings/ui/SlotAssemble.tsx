'use client';
// «Собрать занятие» из свободного слота сетки недели: время уже выбрано (слот), тренер отмечает людей
// из очереди «Теория» (любые темы, до group.max) → POST /queue/assemble. Очередь пуста или нужен
// кто-то вне очереди — «Создать вручную» открывает обычную форму обучения с подставленным слотом.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, MapPin } from 'lucide-react';
import type { TrainingQueueResponse } from '../types';
import { QUEUE_KEY, SLOTS_KEY, TRAININGS_KEY, assembleTraining, getJson } from './api';
import { ddmm, mskDateKey, mskDayLabel, mskTime, endOf } from './format';
import type { TrainingFormPreset } from './TrainingForm';

const INPUT = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base sm:text-sm outline-none focus:border-[var(--color-accent)]';

export interface SlotPick {
  preset: TrainingFormPreset;
  /** «Нулевой цикл · Питер · НЦ · очно» — для шапки. */
  meta: string;
  /** Заранее отмеченные задачи (выбрана тема в полосе очереди над сеткой). */
  preselect?: number[];
}

export function SlotAssemble({ pick, onDone, onManual, onCancel }: {
  pick: SlotPick;
  onDone: (eventId: number) => void;
  onManual: () => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: QUEUE_KEY, queryFn: () => getJson<TrainingQueueResponse>('/api/tasker/trainings/queue') });
  const groups = useMemo(
    () => (q.data?.groups ?? [])
      .map(g => ({ ...g, waitingItems: g.items.filter(i => !i.event && !i.ownSlot).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }))
      .filter(g => g.waitingItems.length > 0)
      // Группа с заранее отмеченными людьми (выбрана тема над сеткой) — первой.
      .sort((a, b) => Number(b.waitingItems.some(i => pick.preselect?.includes(i.taskId))) - Number(a.waitingItems.some(i => pick.preselect?.includes(i.taskId)))),
    [q.data, pick.preselect],
  );
  const min = q.data?.group.min ?? 3;
  // Максимум зависит от тем отмеченных: все — обучения по материалам (товарные группы) → group.maxProduct, иначе group.max.
  const maxOfTask = useMemo(() => new Map(groups.flatMap(g => g.waitingItems.map(i => [i.taskId, g.max] as const))), [groups]);
  const limitFor = (ids: Set<number>) => (ids.size
    ? Math.min(...[...ids].map(id => maxOfTask.get(id) ?? q.data?.group.max ?? 5))
    : Math.max(q.data?.group.max ?? 5, ...groups.map(g => g.max)));
  const [picked, setPicked] = useState<Set<number>>(() => new Set(pick.preselect ?? []));
  const max = limitFor(picked);
  const canAdd = (id: number) => { const n = new Set(picked).add(id); return n.size <= limitFor(n); };
  const [title, setTitle] = useState('');
  const [failed, setFailed] = useState<{ taskId: number; reason: string }[]>([]);

  // Тема по умолчанию — тема первой отмеченной группы.
  const autoTitle = groups.find(g => g.waitingItems.some(i => picked.has(i.taskId)))?.label ?? '';
  const effectiveTitle = title.trim() || autoTitle;
  // Слот закреплён за отделом, а в группе люди из разных отделов — предупреждаем (не запрещаем).
  const pickedDepts = [...new Set(groups.flatMap(g => g.waitingItems.filter(i => picked.has(i.taskId)).map(i => i.departmentName ?? '—')))];
  const deptWarning = pick.preset.departmentLabel && pickedDepts.length > 1
    ? `Слот закреплён за «${pick.preset.departmentLabel}», а в группе люди из ${pickedDepts.length} отделов: ${pickedDepts.join(', ')}.`
    : null;

  const toggle = (id: number) => setPicked(p => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else { const next = new Set(n).add(id); if (next.size <= limitFor(next)) n.add(id); }
    return n;
  });

  const { preset } = pick;
  const mut = useMutation({
    mutationFn: () => assembleTraining({
      taskIds: [...picked], title: effectiveTitle, startsAt: preset.startsAt, durationMin: preset.durationMin,
      place: preset.place, slotId: preset.slotId, departmentLabel: preset.departmentLabel,
    }),
    onSuccess: r => {
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
      qc.invalidateQueries({ queryKey: TRAININGS_KEY });
      qc.invalidateQueries({ queryKey: SLOTS_KEY });
      if (r.failed.length) setFailed(r.failed); else onDone(r.event.id);
    },
  });

  const when = (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-[var(--color-bg-surface)] px-3 py-2.5">
      <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
        <Clock size={14} className="shrink-0 text-[var(--color-accent)]" />
        {mskDayLabel(preset.startsAt)}, {mskTime(preset.startsAt)}–{mskTime(endOf(preset.startsAt, preset.durationMin))}
      </span>
      {(pick.meta || preset.place) && (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[12.5px] text-[var(--color-text-muted)]">
          <MapPin size={12} className="shrink-0" /><span className="min-w-0 break-words">{[pick.meta, preset.place].filter(Boolean).join(' · ')}</span>
        </span>
      )}
    </div>
  );

  if (failed.length && mut.data) {
    const name = new Map(groups.flatMap(g => g.waitingItems.map(i => [i.taskId, i.manager.name] as const)));
    return (
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        <p>Занятие создано, но не всех удалось записать:</p>
        <ul className="list-disc pl-5">{failed.map(f => <li key={f.taskId}>{name.get(f.taskId) ?? `задача ${f.taskId}`}: {f.reason}</li>)}</ul>
        <button type="button" onClick={() => onDone(mut.data!.event.id)} className="min-h-11 self-end rounded-lg bg-[var(--color-accent)] px-4 font-medium text-white">Открыть занятие</button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 text-sm">
      {when}

      {q.isLoading ? (
        <p className="text-[var(--color-text-muted)]">Загружаю очередь тренера…</p>
      ) : q.isError ? (
        <p className="text-[var(--color-negative)]">{(q.error as Error).message}</p>
      ) : groups.length === 0 ? (
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-dashed border-[var(--color-border)] px-4 py-5">
          <p className="font-medium">В очереди тренера сейчас никого нет</p>
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            Люди попадают в очередь, когда РОП ставит менеджеру задачу с типом «Теория». Можно создать занятие и без очереди —
            тему и участников укажете сами.
          </p>
          <button type="button" onClick={onManual} className="min-h-11 self-start rounded-lg bg-[var(--color-accent)] px-4 font-medium text-white">
            Создать занятие вручную
          </button>
        </div>
      ) : (
        <form onSubmit={e => { e.preventDefault(); if (picked.size && effectiveTitle) mut.mutate(); }} className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <h3 className="font-semibold">Кого берём из очереди</h3>
            <span className={`shrink-0 text-[12.5px] tabular-nums ${picked.size && picked.size < min ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-muted)]'}`}>
              отмечено {picked.size} · группа {min}–{max}
            </span>
          </div>
          {groups.map(g => (
            <fieldset key={g.metricId} className="flex min-w-0 flex-col rounded-xl border border-[var(--color-border)]">
              <legend className="sr-only">{g.label}</legend>
              <div className="flex min-w-0 items-center justify-between gap-2 px-3 pt-2.5 pb-1">
                <span className="min-w-0 break-words font-medium">{g.label}</span>
                <span className="shrink-0 text-[12px] text-[var(--color-text-muted)]">ждут {g.waitingItems.length}</span>
              </div>
              {g.waitingItems.map(i => {
                const on = picked.has(i.taskId);
                const disabled = !on && !canAdd(i.taskId);
                return (
                  <label key={i.taskId} className={`flex min-h-11 min-w-0 cursor-pointer items-center gap-2.5 border-t border-[var(--color-border)] px-3 py-2 ${disabled ? 'opacity-50' : 'hover:bg-[var(--color-bg-hover)]'}`}>
                    <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggle(i.taskId)} className="size-4 shrink-0 accent-[var(--color-accent)]" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="min-w-0 break-words">{i.manager.name}</span>
                      <span className="min-w-0 truncate text-[12px] text-[var(--color-text-muted)]">
                        {[i.departmentName, `ждёт с ${ddmm(mskDateKey(i.createdAt))}`].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          ))}
          <label className="flex min-w-0 flex-col gap-1 text-[13px] text-[var(--color-text-secondary)]">
            Тема занятия
            <input className={INPUT} value={title} onChange={e => setTitle(e.target.value)} maxLength={200}
              placeholder={autoTitle || 'Отметьте людей — тема подставится'} />
          </label>
          {deptWarning && <p className="text-[12.5px] text-[var(--color-warning)]">{deptWarning}</p>}
          {mut.isError && <p className="text-[13px] text-[var(--color-negative)]">{(mut.error as Error).message}</p>}
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={onManual} className="min-h-11 rounded-lg px-2 text-[var(--color-accent)] hover:underline">
              Создать вручную, без очереди
            </button>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={onCancel} className="min-h-11 rounded-lg border border-[var(--color-border)] px-4 hover:bg-[var(--color-bg-hover)]">Отмена</button>
              <button type="submit" disabled={!picked.size || !effectiveTitle || mut.isPending}
                className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 font-medium text-white disabled:opacity-50">
                {mut.isPending ? 'Собираю…' : picked.size ? `Собрать занятие (${picked.size})` : 'Отметьте людей'}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
