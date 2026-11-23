'use client';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Sparkles, Users } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import type { TaskerMetric } from '../../types';
import type {
  TrainingGroupSettings, TrainingQueueGroup, TrainingQueueItem, TrainingQueueResponse, TrainingSuggestion,
} from '../types';
import { QUEUE_KEY, SLOTS_KEY, TRAININGS_KEY, assembleTraining, getJson, suggestSlots } from './api';
import { ddmm, fmtMetric, isoWeekday, mskDateKey, mskTime, mskToIso, WEEKDAYS_SHORT } from './format';

const INPUT = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base sm:text-sm outline-none focus:border-[var(--color-accent)]';
const LABEL = 'flex min-w-0 flex-col gap-1 text-[13px] text-[var(--color-text-secondary)]';

const slotText = (s: { startsAt: string; durationMin: number }) => {
  const d = mskDateKey(s.startsAt);
  return `${WEEKDAYS_SHORT[isoWeekday(d)]} ${ddmm(d)}, ${mskTime(s.startsAt)}`;
};

/**
 * Очередь тренера: открытые задачи «Теория» по всем менеджерам, по темам (показателям). Тренер отмечает людей и
 * собирает занятие; если по теме ждут ≥ min — сразу видно предложение ближайшего свободного слота.
 */
export function TrainerQueue({ onOpenEvent }: { onOpenEvent: (id: number) => void }) {
  const q = useQuery({ queryKey: QUEUE_KEY, queryFn: () => getJson<TrainingQueueResponse>('/api/tasker/trainings/queue') });
  const [assembling, setAssembling] = useState<{ group: TrainingQueueGroup; items: TrainingQueueItem[]; suggestion: TrainingSuggestion | null } | null>(null);

  if (q.isLoading) return <p className="text-sm text-[var(--color-text-muted)]">Загружаю очередь…</p>;
  if (q.isError) return <p className="text-sm text-[var(--color-negative)]">{(q.error as Error).message}</p>;
  const data = q.data!;
  const metrics = new Map(data.metrics.map(m => [m.id, m]));

  return (
    <section className="flex min-w-0 flex-col gap-3">
      {!data.available ? (
        <Empty text="Тип задачи «Теория / Практика» ещё не развёрнут в Задачнике — очередь появится, когда РОПы начнут ставить задачи на тренера." />
      ) : data.groups.length === 0 ? (
        <Empty title="Очередь пуста" text={`Люди попадают сюда, когда РОП ставит менеджеру задачу с типом «Теория» — она уходит на тренера (${data.trainer.name}). Набралось ${data.group.min}+ человек по теме — система предложит свободный слот.`} />
      ) : (
        <>
        <p className="text-[13px] text-[var(--color-text-secondary)]">
          Отметьте {data.group.min}–{data.group.max} человек по теме и нажмите «Собрать занятие» — менеджеры запишутся, в календаре появится встреча.
        </p>
        {data.groups.map(g => (
          <QueueGroup key={g.metricId} g={g} metric={metrics.get(g.metricId)} settings={data.group} canManage={data.canManage}
            onOpenEvent={onOpenEvent} onAssemble={(items, suggestion) => setAssembling({ group: g, items, suggestion })} />
        ))}
        </>
      )}
      <Drawer open={assembling !== null} onOpenChange={o => { if (!o) setAssembling(null); }} title="Собрать занятие">
        {assembling && (
          <AssembleForm key={assembling.items.map(i => i.taskId).join(',')} {...assembling} settings={data.group}
            onDone={id => { setAssembling(null); onOpenEvent(id); }} onCancel={() => setAssembling(null)} />
        )}
      </Drawer>
    </section>
  );
}

function Empty({ title, text }: { title?: string; text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
      {title && <p className="mb-1 font-medium text-[var(--color-text)]">{title}</p>}
      <p className="mx-auto max-w-xl">{text}</p>
    </div>
  );
}

/** Сколько дней ждёт задача (с постановки). */
const waitDays = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));

function QueueGroup({ g, metric, settings, canManage, onAssemble, onOpenEvent }: {
  g: TrainingQueueGroup; metric: TaskerMetric | undefined; settings: TrainingGroupSettings; canManage: boolean;
  onAssemble: (items: TrainingQueueItem[], suggestion: TrainingSuggestion | null) => void; onOpenEvent: (id: number) => void;
}) {
  // Дольше ждущие — первыми.
  const waiting = useMemo(() => g.items.filter(i => !i.event).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [g.items]);
  const planned = g.items.filter(i => i.event);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  // Ничего не отмечено — предложение считается для первых по давности (до target).
  const basis = picked.size ? waiting.filter(i => picked.has(i.taskId)) : waiting.slice(0, settings.target);
  const wantSuggest = canManage && waiting.length >= settings.min;
  const sq = useQuery({
    queryKey: [...QUEUE_KEY, 'suggest', g.metricId, basis.map(i => i.taskId).join(',')],
    queryFn: () => suggestSlots({ metricId: g.metricId, taskIds: basis.map(i => i.taskId), limit: 1 }),
    enabled: wantSuggest && basis.length > 0,
    staleTime: 60_000,
  });
  const suggestion = sq.data?.suggestions[0] ?? null;
  const toggle = (id: number) => setPicked(p => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id); else if (n.size < settings.max) n.add(id);
    return n;
  });
  const fmt = metric?.format ?? 'percent';

  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--color-border)] p-3">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 break-words text-[15px] font-semibold">{g.label}</h2>
        <span className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-[var(--color-text-secondary)]">
          <Users size={13} /> ждут {g.waiting}{planned.length ? ` · назначено ${planned.length}` : ''}
        </span>
      </header>

      {wantSuggest && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] px-2.5 py-2 text-[13px]">
          <Sparkles size={14} className="shrink-0 text-[var(--color-accent)]" />
          {sq.isLoading ? <span className="text-[var(--color-text-muted)]">Ищу свободный слот…</span>
            : sq.isError ? <span className="text-[var(--color-negative)]">{(sq.error as Error).message}</span>
            : suggestion ? (
              <span className="min-w-0 flex-1">
                Набралось {waiting.length} — предлагаю <b>{slotText(suggestion)}</b>
                {suggestion.slotLabel ? ` · ${suggestion.slotLabel}` : ''}
                {suggestion.busy.length ? <span className="text-[var(--color-negative)]"> · заняты: {suggestion.busy.map(b => b.name).join(', ')}</span> : ' · все свободны'}
                {!suggestion.bitrixChecked && <span className="text-[var(--color-text-muted)]"> (календарь Битрикса не проверен)</span>}
              </span>
            ) : <span className="text-[var(--color-text-muted)]">В ближайшие {settings.horizonDays} дн. свободного слота нет — выберите время вручную.</span>}
        </div>
      )}

      <ul className="flex min-w-0 flex-col">
        {waiting.map(i => (
          <li key={i.taskId} className="flex min-w-0 items-start gap-2 border-t border-[var(--color-border)] py-2 first:border-t-0">
            {canManage && (
              <input type="checkbox" checked={picked.has(i.taskId)} onChange={() => toggle(i.taskId)}
                disabled={!picked.has(i.taskId) && picked.size >= settings.max}
                aria-label={`Взять ${i.manager.name}`} className="tap-target mt-1 size-4 shrink-0 accent-[var(--color-accent)]" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="min-w-0 break-words text-sm font-medium">{i.manager.name}</span>
              <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-[var(--color-text-muted)]">
                {i.departmentName && <span className="min-w-0 truncate">{i.departmentName}</span>}
                {i.snapshot && <span>сейчас {fmtMetric(i.snapshot.value, fmt)}{i.snapshot.deptAvg != null ? ` (отдел ${fmtMetric(i.snapshot.deptAvg, fmt)})` : ''}</span>}
                <span className={waitDays(i.createdAt) >= 7 ? 'font-medium text-[var(--color-warning)]' : ''}>ждёт {waitDays(i.createdAt)} дн.</span>
                <span>поставил {i.creatorName ?? i.ropName ?? '—'} {ddmm(mskDateKey(i.createdAt))}</span>
              </span>
            </div>
          </li>
        ))}
        {planned.map(i => (
          <li key={i.taskId} className="flex min-w-0 items-start gap-2 border-t border-[var(--color-border)] py-2 opacity-70">
            <CalendarCheck size={15} className="mt-0.5 shrink-0 text-[var(--color-positive)]" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="min-w-0 break-words text-sm">{i.manager.name}</span>
              <button type="button" onClick={() => onOpenEvent(i.event!.id)} className="min-w-0 self-start truncate text-left text-[12px] text-[var(--color-accent)] hover:underline">
                {slotText({ startsAt: i.event!.startsAt, durationMin: 0 })} · {i.event!.title}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {canManage && waiting.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {picked.size > 0 && <span className="text-[12.5px] text-[var(--color-text-muted)]">отмечено {picked.size} из {settings.max}</span>}
          <button type="button"
            onClick={() => onAssemble(picked.size ? waiting.filter(i => picked.has(i.taskId)) : waiting.slice(0, settings.target), suggestion)}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white">
            Собрать занятие{picked.size ? '' : ` (первые ${Math.min(waiting.length, settings.target)})`}
          </button>
        </div>
      )}
    </article>
  );
}

function AssembleForm({ group, items, suggestion, settings, onDone, onCancel }: {
  group: TrainingQueueGroup; items: TrainingQueueItem[]; suggestion: TrainingSuggestion | null; settings: TrainingGroupSettings;
  onDone: (eventId: number) => void; onCancel: () => void;
}) {
  const qc = useQueryClient();
  const taskIds = items.map(i => i.taskId);
  const alt = useQuery({
    queryKey: [...QUEUE_KEY, 'suggest', group.metricId, taskIds.join(','), 4],
    queryFn: () => suggestSlots({ metricId: group.metricId, taskIds, limit: 4 }),
    staleTime: 60_000,
  });
  const options = alt.data?.suggestions ?? (suggestion ? [suggestion] : []);
  const [choice, setChoice] = useState<TrainingSuggestion | null>(suggestion);
  useEffect(() => { if (!choice && options[0]) setChoice(options[0]); }, [options, choice]);
  const [manual, setManual] = useState(false);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('10:15');
  const [duration, setDuration] = useState('45');
  const [title, setTitle] = useState(group.label);
  const [description, setDescription] = useState('');
  const [place, setPlace] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ taskId: number; reason: string }[]>([]);

  const mut = useMutation({
    mutationFn: () => {
      const useManual = manual || !choice;
      if (useManual && !date) throw new Error('Укажите дату');
      return assembleTraining({
        taskIds, title: title.trim(), description,
        startsAt: useManual ? mskToIso(date, time) : choice!.startsAt,
        durationMin: useManual ? Number(duration) : choice!.durationMin,
        place: place.trim() || (useManual ? null : choice!.place),
        slotId: useManual ? null : choice!.slotId,
        departmentLabel: useManual ? null : choice!.departmentLabel,
      });
    },
    onMutate: () => setErr(null),
    onSuccess: r => {
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
      qc.invalidateQueries({ queryKey: TRAININGS_KEY });
      qc.invalidateQueries({ queryKey: SLOTS_KEY });
      if (r.failed.length) setFailed(r.failed); else onDone(r.event.id);
    },
    onError: (e: Error) => setErr(e.message),
  });

  if (failed.length && mut.data) {
    const name = new Map(items.map(i => [i.taskId, i.manager.name]));
    return (
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        <p>Занятие создано, но не всех удалось записать:</p>
        <ul className="list-disc pl-5">{failed.map(f => <li key={f.taskId}>{name.get(f.taskId) ?? `задача ${f.taskId}`}: {f.reason}</li>)}</ul>
        <button type="button" onClick={() => onDone(mut.data!.event.id)} className="min-h-11 self-end rounded-lg bg-[var(--color-accent)] px-4 font-medium text-white">Открыть занятие</button>
      </div>
    );
  }

  return (
    <form onSubmit={e => { e.preventDefault(); if (!title.trim()) return setErr('Укажите тему'); mut.mutate(); }} className="flex min-w-0 flex-col gap-3 text-sm">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[13px] text-[var(--color-text-secondary)]">Группа ({items.length} из максимум {settings.max})</span>
        <ul className="flex min-w-0 flex-wrap gap-1.5">
          {items.map(i => <li key={i.taskId} className="max-w-full truncate rounded-full bg-[var(--color-bg-hover)] px-2.5 py-1 text-[12.5px]">{i.manager.name}</li>)}
        </ul>
        {items.length < settings.min && <span className="text-[12px] text-[var(--color-text-muted)]">Обычно собираем от {settings.min} — можно и меньше.</span>}
      </div>
      <label className={LABEL}>
        Тема
        <input className={INPUT} value={title} onChange={e => setTitle(e.target.value)} maxLength={200} />
      </label>

      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-1 text-[13px] text-[var(--color-text-secondary)]">Когда</legend>
        {alt.isLoading && !options.length && <span className="text-[12.5px] text-[var(--color-text-muted)]">Подбираю слоты…</span>}
        {options.map(o => {
          const on = !manual && choice?.startsAt === o.startsAt;
          return (
            <button key={o.startsAt} type="button" onClick={() => { setManual(false); setChoice(o); }} aria-pressed={on}
              className={`flex min-h-11 w-full min-w-0 flex-col rounded-lg border px-3 py-2 text-left ${on ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]' : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>
              <span className="font-medium">{slotText(o)} · {o.durationMin} мин{o.slotLabel ? ` · ${o.slotLabel}` : ''}</span>
              <span className={`text-[12px] ${o.busy.length ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`}>
                {o.busy.length ? `Заняты: ${o.busy.map(b => `${b.name} (${b.title})`).join(', ')}` : 'Все свободны'}
                {o.departmentLabel ? ` · ${o.departmentLabel}` : ''}
              </span>
            </button>
          );
        })}
        <button type="button" onClick={() => setManual(true)} aria-pressed={manual || !options.length}
          className={`min-h-11 rounded-lg border px-3 text-left ${manual || !options.length ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>
          Другое время
        </button>
        {(manual || !options.length) && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className={LABEL}>Дата<input type="date" className={INPUT} value={date} onChange={e => setDate(e.target.value)} /></label>
            <label className={LABEL}>Начало (МСК)<input type="time" className={INPUT} value={time} onChange={e => setTime(e.target.value)} step={300} /></label>
            <label className={LABEL}>Минут<input type="number" inputMode="numeric" min={10} max={600} className={INPUT} value={duration} onChange={e => setDuration(e.target.value)} /></label>
          </div>
        )}
      </fieldset>

      <label className={LABEL}>
        Место или ссылка
        <input className={INPUT} value={place} onChange={e => setPlace(e.target.value)} maxLength={500}
          placeholder={(!manual && choice?.place) || 'Ссылка на созвон или переговорная'} />
      </label>
      <label className={LABEL}>
        Описание / программа
        <textarea className={`${INPUT} min-h-24 py-2`} value={description} onChange={e => setDescription(e.target.value)} rows={4} placeholder="Что разбираем" />
      </label>
      {err && <p className="text-[13px] text-[var(--color-negative)]">{err}</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} disabled={mut.isPending} className="min-h-11 rounded-lg border border-[var(--color-border)] px-4 hover:bg-[var(--color-bg-hover)]">Отмена</button>
        <button type="submit" disabled={mut.isPending} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 font-medium text-white disabled:opacity-50">
          {mut.isPending ? 'Собираю…' : 'Создать занятие'}
        </button>
      </div>
    </form>
  );
}
