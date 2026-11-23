'use client';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, MapPin, Settings, Users } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { TrainingEvent, TrainingEventInput, TrainingEventResponse, TrainingQueueResponse, TrainingsResponse } from '../types';
import { TaskerTabs } from '../../ui/shared/TaskerPage';
import {
  QUEUE_KEY, TRAININGS_KEY, cancelTraining, createTraining, enrollManager, getJson, resyncTraining, setAttendance, unenrollManager, updateTraining,
} from './api';
import { addDaysKey, durationLabel, endOf, mskDateKey, mskDayLabel, mskTime } from './format';
import { TrainingDetails } from './TrainingDetails';
import { TrainingForm, type TrainingFormPreset } from './TrainingForm';
import { EffectivenessView } from './EffectivenessView';
import { WeekGrid } from './WeekGrid';
import { TrainerQueue } from './TrainerQueue';
import { SlotSettings } from './SlotSettings';

type Mode = 'week' | 'queue' | 'upcoming' | 'past' | 'effect' | 'settings';
type Panel = { kind: 'view'; id: number } | { kind: 'edit'; id: number } | { kind: 'create'; preset?: TrainingFormPreset } | null;
const MODES: Mode[] = ['week', 'queue', 'upcoming', 'past', 'effect', 'settings'];
const MODE_LABEL: Record<Mode, string> = {
  week: 'Неделя', queue: 'Очередь тренера', upcoming: 'Ближайшие', past: 'Прошедшие', effect: 'Эффективность', settings: 'Настройки',
};

// Второй уровень вкладок (под вкладками Задачника) — лёгкий, с подчёркиванием, перенос строки вместо ленты (CLAUDE.md, п.12).
const subTab = (on: boolean) => `inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 border-b-2 px-2 text-sm sm:px-2.5 ${on ? 'border-[var(--color-accent)] font-medium text-[var(--color-accent)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'}`;

/** Расписание обучений Задачника (/tasker/trainings): видят все, ведёт тренер, РОП записывает своих. */
export function TrainingsPage() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('week');
  const [panel, setPanel] = useState<Panel>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [linkManager, setLinkManager] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  // Ссылки: ?event=ID (из описания задачи Битрикса), ?tab=effect&manager=ID (история из карточки задачи).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const ev = Number(sp.get('event'));
    if (Number.isInteger(ev) && ev > 0) setPanel({ kind: 'view', id: ev });
    const tab = sp.get('tab') as Mode | null;
    if (tab && MODES.includes(tab)) setMode(tab);
    const m = sp.get('manager');
    if (m && /^\d+$/.test(m)) setLinkManager(m);
  }, []);

  const today = mskDateKey(new Date());
  const url = mode !== 'past'
    ? '/api/tasker/trainings?upcoming=1&includeCancelled=1'
    : `/api/tasker/trainings?from=${addDaysKey(today, -90)}&to=${today}&includeCancelled=1`;
  const listMode = mode === 'past' ? 'past' : 'upcoming';
  const q = useQuery({ queryKey: [...TRAININGS_KEY, listMode], queryFn: () => getJson<TrainingsResponse>(url) });

  const events = useMemo(() => {
    const all = q.data?.events ?? [];
    // Отменённые — только по галочке (как в «Собраниях»): в рабочем списке они шум.
    const list = showCancelled ? all : all.filter(e => !e.cancelledAt);
    if (mode !== 'past') return list;
    const now = Date.now();
    return list.filter(e => endOf(e.startsAt, e.durationMin).getTime() <= now).reverse();
  }, [q.data, mode, showCancelled]);
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
  const panelId = panel && panel.kind !== 'create' ? panel.id : null;
  const inList = panelId !== null ? events.find(e => e.id === panelId) ?? null : null;
  // Событие не из текущего списка (прошедшее, отменённое, по ссылке) — грузим отдельно.
  const single = useQuery({
    queryKey: [...TRAININGS_KEY, 'one', panelId],
    queryFn: () => getJson<TrainingEventResponse>(`/api/tasker/trainings/${panelId}`),
    enabled: panelId !== null && !inList && !q.isLoading,
    retry: false,
  });
  const current = inList ?? single.data?.event ?? null;
  const metrics = q.data?.metrics ?? [];
  const queueQ = useQuery({
    queryKey: QUEUE_KEY,
    queryFn: () => getJson<TrainingQueueResponse>('/api/tasker/trainings/queue'),
    enabled: canManage || canEnroll,
  });
  const queueCount = (queueQ.data?.groups ?? []).reduce((n, g) => n + g.items.filter(i => !i.event).length, 0);
  const cancelledCount = (q.data?.events ?? []).filter(e => e.cancelledAt).length;

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
      <div className="flex w-full min-w-0 flex-col gap-3 px-4 pb-6 pt-4 sm:px-6 sm:pt-6">
        {/* Шапка как у остальных экранов Задачника: заголовок, главное действие, вкладки раздела. */}
        <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Задачник</h1>
          {canManage && (
            <button type="button" onClick={() => openPanel({ kind: 'create' })}
              className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]">
              <CalendarPlus size={16} aria-hidden /> Новое обучение
            </button>
          )}
        </header>
        <TaskerTabs active="trainings" />

        <div className="flex min-w-0 flex-wrap items-center gap-x-1 border-b border-[var(--color-border)]" role="tablist" aria-label="Обучения">
          {MODES.filter(m => (m === 'settings' ? canManage : m === 'queue' ? canManage || canEnroll : true)).map(m => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={subTab(mode === m)}>
              {m === 'settings' && <Settings size={14} aria-hidden />}
              {/* На телефоне — короткие подписи, чтобы второй ряд вкладок не занимал полэкрана. */}
              {m === 'settings' ? <span className="sr-only sm:not-sr-only">{MODE_LABEL[m]}</span>
                : m === 'queue' ? <><span className="sm:hidden">Очередь</span><span className="hidden sm:inline">{MODE_LABEL[m]}</span></>
                : m === 'effect' ? <><span className="sm:hidden">Эффект</span><span className="hidden sm:inline">{MODE_LABEL[m]}</span></>
                : MODE_LABEL[m]}
              {m === 'queue' && queueCount > 0 && (
                <span className="rounded-full bg-[var(--color-accent)] px-1.5 text-[11px] font-medium tabular-nums text-white">{queueCount}</span>
              )}
            </button>
          ))}
        </div>

        {(mode === 'upcoming' || mode === 'past') && cancelledCount > 0 && (
          <label className="inline-flex min-h-11 items-center gap-2 self-start text-[13px] text-[var(--color-text-secondary)]">
            <input type="checkbox" checked={showCancelled} onChange={e => setShowCancelled(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
            показать отменённые ({cancelledCount})
          </label>
        )}

        {mode === 'week' ? (
          <WeekGrid canManage={canManage} canEnroll={canEnroll} onOpenQueue={() => setMode('queue')} onOpen={id => openPanel({ kind: 'view', id })} onCreate={preset => openPanel({ kind: 'create', preset })} />
        ) : mode === 'queue' ? (
          <TrainerQueue onOpenEvent={id => openPanel({ kind: 'view', id })} />
        ) : mode === 'settings' ? (
          <SlotSettings />
        ) : mode === 'effect' ? (
          <EffectivenessView canPickManager={canEnroll || canManage} initialManager={linkManager} />
        ) : q.isLoading ? (
          <div className="flex min-w-0 flex-col gap-2" aria-busy>{[0, 1, 2].map(i => <div key={i} className="h-16 animate-pulse rounded-xl bg-[var(--color-bg-surface)]" />)}</div>
        ) : q.isError ? (
          <p className="text-sm text-[var(--color-negative)]">{(q.error as Error).message}</p>
        ) : days.length === 0 ? (
          <div className="flex min-w-0 flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
            <span>
              {mode === 'upcoming'
                ? canManage ? 'Ближайших занятий нет. Соберите группу из очереди тренера или в свободном слоте недели.' : 'Ближайших занятий пока нет — когда тренер назначит, они появятся здесь.'
                : 'За последние 90 дней занятий не было.'}
            </span>
            {mode === 'upcoming' && canManage && (
              <button type="button" onClick={() => setMode('week')} className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 font-medium text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
                Открыть сетку недели
              </button>
            )}
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
          <TrainingForm metrics={metrics} preset={panel.preset} pending={mut.isPending} error={err} onSubmit={save} onCancel={() => setPanel(null)} />
        )}
        {panel?.kind === 'edit' && current && (
          <TrainingForm key={current.id} metrics={metrics} initial={current} pending={mut.isPending} error={err} onSubmit={save}
            onCancel={() => openPanel({ kind: 'view', id: current.id })} />
        )}
        {panel?.kind === 'view' && current && (
          <TrainingDetails
            event={current}
            canManage={canManage}
            canEnroll={canEnroll}
            busy={mut.isPending}
            error={err}
            metrics={metrics}
            onEnroll={(id, goals, note) => run(() => enrollManager(current.id, id, goals, note))}
            onAttendance={(id, attended) => run(() => setAttendance(current.id, id, attended))}
            onUnenroll={id => run(() => unenrollManager(current.id, id))}
            onEdit={() => openPanel({ kind: 'edit', id: current.id })}
            onCancelEvent={() => setConfirmCancel(true)}
            onResync={() => run(() => resyncTraining(current.id))}
          />
        )}
        {panel && panel.kind !== 'create' && !current && (
          <p className="text-sm text-[var(--color-text-muted)]">{q.isFetching || single.isFetching ? 'Загружаю…' : 'Обучение не найдено.'}</p>
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
