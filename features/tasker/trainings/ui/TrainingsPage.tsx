'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarPlus, GraduationCap, MapPin, Users } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { TrainingEvent, TrainingEventInput, TrainingsResponse } from '../types';
import {
  TRAININGS_KEY, cancelTraining, createTraining, enrollManager, getJson, resyncTraining, unenrollManager, updateTraining,
} from './api';
import { addDaysKey, durationLabel, endOf, mskDateKey, mskDayLabel, mskTime } from './format';
import { TrainingDetails } from './TrainingDetails';
import { TrainingForm } from './TrainingForm';

type Mode = 'upcoming' | 'past';
type Panel = { kind: 'view'; id: number } | { kind: 'edit'; id: number } | { kind: 'create' } | null;

const TAB = 'min-h-11 rounded-lg px-4 text-sm font-medium';

/** Расписание обучений Задачника (/tasker/trainings): видят все, ведёт тренер, РОП записывает своих. */
export function TrainingsPage() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('upcoming');
  const [panel, setPanel] = useState<Panel>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const today = mskDateKey(new Date());
  const url = mode === 'upcoming'
    ? '/api/tasker/trainings?upcoming=1&includeCancelled=1'
    : `/api/tasker/trainings?from=${addDaysKey(today, -90)}&to=${today}&includeCancelled=1`;
  const q = useQuery({ queryKey: [...TRAININGS_KEY, mode], queryFn: () => getJson<TrainingsResponse>(url) });

  const events = useMemo(() => {
    const list = q.data?.events ?? [];
    if (mode === 'upcoming') return list;
    const now = Date.now();
    return list.filter(e => endOf(e.startsAt, e.durationMin).getTime() <= now).reverse();
  }, [q.data, mode]);
  const days = useMemo(() => {
    const m = new Map<string, TrainingEvent[]>();
    for (const e of events) {
      const k = mskDateKey(e.startsAt);
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m.entries()];
  }, [events]);

  const canManage = q.data?.canManage ?? false;
  const canEnroll = q.data?.canEnroll ?? false;
  const current = panel && panel.kind !== 'create' ? events.find(e => e.id === panel.id) ?? null : null;

  const refresh = () => qc.invalidateQueries({ queryKey: TRAININGS_KEY });
  const mut = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onMutate: () => setErr(null),
    onSuccess: () => refresh(),
    onError: (e: Error) => setErr(e.message),
  });
  const run = (fn: () => Promise<unknown>, after?: () => void) => mut.mutate(fn, { onSuccess: () => after?.() });

  const openPanel = (p: Panel) => { setErr(null); setPanel(p); };
  const save = (input: TrainingEventInput) => {
    if (panel?.kind === 'edit') run(() => updateTraining(panel.id, input), () => setPanel({ kind: 'view', id: panel.id }));
    else run(async () => { const r = await createTraining(input); setPanel({ kind: 'view', id: r.event.id }); });
  };

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-3 py-4 sm:px-6">
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Link href="/tasker" aria-label="Задачник" className="tap-target flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
              <ArrowLeft size={18} />
            </Link>
            <GraduationCap size={22} className="shrink-0 text-[var(--color-accent)]" />
            <h1 className="min-w-0 truncate text-lg font-semibold">Обучения</h1>
          </div>
          {canManage && (
            <button type="button" onClick={() => openPanel({ kind: 'create' })}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white">
              <CalendarPlus size={16} /> Новое обучение
            </button>
          )}
        </header>

        <div className="flex flex-wrap gap-2" role="tablist">
          {(['upcoming', 'past'] as const).map(m => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
              className={`${TAB} ${mode === m ? 'bg-[var(--color-accent)] text-white' : 'border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>
              {m === 'upcoming' ? 'Ближайшие' : 'Прошедшие (90 дней)'}
            </button>
          ))}
        </div>

        {q.isLoading ? (
          <p className="text-sm text-[var(--color-text-muted)]">Загружаю расписание…</p>
        ) : q.isError ? (
          <p className="text-sm text-[var(--color-negative)]">{(q.error as Error).message}</p>
        ) : days.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">
            {mode === 'upcoming'
              ? canManage ? 'Ближайших обучений нет — создайте первое.' : 'Ближайших обучений пока нет.'
              : 'За последние 90 дней обучений не было.'}
          </div>
        ) : (
          days.map(([day, list]) => (
            <section key={day} className="flex min-w-0 flex-col gap-2">
              <h2 className="text-[13px] font-semibold text-[var(--color-text-secondary)]">
                {day === today ? 'Сегодня · ' : day === addDaysKey(today, 1) ? 'Завтра · ' : ''}{mskDayLabel(list[0].startsAt)}
              </h2>
              <ul className="flex min-w-0 flex-col gap-2">
                {list.map(e => <EventCard key={e.id} e={e} onOpen={() => openPanel({ kind: 'view', id: e.id })} />)}
              </ul>
            </section>
          ))
        )}
      </div>

      <Drawer
        open={panel !== null}
        onOpenChange={o => { if (!o) setPanel(null); }}
        title={panel?.kind === 'create' ? 'Новое обучение' : panel?.kind === 'edit' ? 'Изменить обучение' : 'Обучение'}
      >
        {panel?.kind === 'create' && (
          <TrainingForm pending={mut.isPending} error={err} onSubmit={save} onCancel={() => setPanel(null)} />
        )}
        {panel?.kind === 'edit' && current && (
          <TrainingForm key={current.id} initial={current} pending={mut.isPending} error={err} onSubmit={save}
            onCancel={() => openPanel({ kind: 'view', id: current.id })} />
        )}
        {panel?.kind === 'view' && current && (
          <TrainingDetails
            event={current}
            canManage={canManage}
            canEnroll={canEnroll}
            busy={mut.isPending}
            error={err}
            onEnroll={id => run(() => enrollManager(current.id, id))}
            onUnenroll={id => run(() => unenrollManager(current.id, id))}
            onEdit={() => openPanel({ kind: 'edit', id: current.id })}
            onCancelEvent={() => setConfirmCancel(true)}
            onResync={() => run(() => resyncTraining(current.id))}
          />
        )}
        {panel && panel.kind !== 'create' && !current && (
          <p className="text-sm text-[var(--color-text-muted)]">{q.isFetching ? 'Загружаю…' : 'Обучение не найдено в текущем списке.'}</p>
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmCancel}
        title="Отменить обучение?"
        description={current ? `«${current.title}» исчезнет из ближайших у всех и из календаря тренера в Битриксе (участникам придёт отмена); записи менеджеров сохранятся в истории.` : ''}
        confirmLabel="Отменить обучение"
        cancelLabel="Не отменять"
        tone="danger"
        pending={mut.isPending}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => { if (current) run(() => cancelTraining(current.id), () => setConfirmCancel(false)); }}
      />
    </div>
  );
}

function EventCard({ e, onOpen }: { e: TrainingEvent; onOpen: () => void }) {
  const cancelled = !!e.cancelledAt;
  const full = e.capacity != null && e.enrolledCount >= e.capacity;
  return (
    <li>
      <button type="button" onClick={onOpen}
        className={`flex w-full min-w-0 flex-col gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-card,transparent)] px-3 py-3 text-left hover:bg-[var(--color-bg-hover)] sm:flex-row sm:items-center sm:gap-4 ${cancelled ? 'opacity-60' : ''}`}>
        <span className="shrink-0 text-sm font-semibold tabular-nums sm:w-28">
          {mskTime(e.startsAt)}–{mskTime(endOf(e.startsAt, e.durationMin))}
          <span className="ml-2 font-normal text-[var(--color-text-muted)] sm:ml-0 sm:block sm:text-[12px]">{durationLabel(e.durationMin)}</span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={`min-w-0 break-words font-medium ${cancelled ? 'line-through' : ''}`}>{e.title}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-[var(--color-text-muted)]">
            {cancelled && <span className="text-[var(--color-negative)]">отменено</span>}
            {e.trainer && <span className="min-w-0 truncate">{e.trainer.name}</span>}
            {e.place && <span className="inline-flex min-w-0 max-w-full items-center gap-1"><MapPin size={12} className="shrink-0" /><span className="truncate">{e.place}</span></span>}
          </span>
        </span>
        <span className={`inline-flex shrink-0 items-center gap-1 text-[12.5px] ${full ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-secondary)]'}`}>
          <Users size={13} /> {e.enrolledCount}{e.capacity != null ? ` / ${e.capacity}` : ''}
        </span>
      </button>
    </li>
  );
}
