'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, CalendarCheck, CalendarX, MapPin, Pencil, RefreshCw, UserPlus, Users, X, Ban, ExternalLink, Target } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import type { TaskerMetric } from '../../types';
import type { TrainingEvent, TrainingManagersResponse } from '../types';
import { AttendanceBadge, EffectSummaryLine, MetricChips, OutcomeBadge, ResultLines } from './EffectBits';
import { getJson } from './api';
import { AvailabilityWarning } from '../../ui/shared/AvailabilityWarning';
import { durationLabel, endOf, isUrl, mskDayLabel, mskTime, plural } from './format';
import { TrainingTestBlock } from '../../tests/ui/TrainingTestBlock';

/**
 * Содержимое карточки обучения (в Drawer): детали, показатели и сводка эффективности, записанные (цель, посещение,
 * замер), запись с целью / отписка, действия тренера (правка, отмена, посещаемость, календарь).
 */
export function TrainingDetails({
  event,
  canManage,
  canEnroll,
  busy,
  error,
  onEnroll,
  onUnenroll,
  onEdit,
  onCancelEvent,
  onResync,
  onAttendance,
  metrics,
}: {
  event: TrainingEvent;
  canManage: boolean;
  canEnroll: boolean;
  busy: boolean;
  error: string | null;
  onEnroll: (managerId: number, goalMetricIds: string[], goalNote: string) => void;
  onAttendance: (managerId: number, attended: boolean | null) => void;
  metrics: TaskerMetric[];
  onUnenroll: (managerId: number) => void;
  onEdit: () => void;
  onCancelEvent: () => void;
  onResync: () => void;
}) {
  const [pick, setPick] = useState('');
  const [goals, setGoals] = useState<string[]>(event.metricIds);
  const [note, setNote] = useState('');
  const metricMap = useMemo(() => new Map(metrics.map(m => [m.id, m])), [metrics]);
  const metricOptions = useMemo(() => metrics.map(m => ({ value: m.id, label: m.label })), [metrics]);
  const started = new Date(event.startsAt).getTime() <= Date.now();
  const ended = endOf(event.startsAt, event.durationMin).getTime() <= Date.now();
  const cancelled = !!event.cancelledAt;
  const full = event.capacity != null && event.enrolledCount >= event.capacity;
  const open = !cancelled && !ended;

  const managers = useQuery({
    queryKey: ['tasker-trainings-managers'],
    queryFn: () => getJson<TrainingManagersResponse>('/api/tasker/trainings/managers'),
    enabled: canEnroll && open,
    staleTime: 5 * 60_000,
  });
  const enrolledIds = new Set(event.attendees.map(a => a.manager.id));
  const options = (managers.data?.managers ?? [])
    .filter(m => !enrolledIds.has(m.id))
    .map(m => ({ value: String(m.id), label: m.name, hint: m.departmentName }));
  const hidden = event.enrolledCount - event.attendees.length;

  return (
    <div className="flex min-w-0 flex-col gap-4 text-sm">
      {cancelled && <p className="rounded-lg border border-[var(--color-negative)] px-3 py-2 text-[var(--color-negative)]">Обучение отменено</p>}

      <div className="flex min-w-0 flex-col gap-1.5">
        <h2 className={`text-base font-semibold ${cancelled ? 'line-through opacity-70' : ''}`}>{event.title}</h2>
        <p className="flex items-start gap-2 text-[var(--color-text-secondary)]">
          <CalendarClock size={16} className="mt-0.5 shrink-0" />
          <span>{mskDayLabel(event.startsAt)}, {mskTime(event.startsAt)}–{mskTime(endOf(event.startsAt, event.durationMin))} МСК · {durationLabel(event.durationMin)}</span>
        </p>
        {event.place && (
          <p className="flex min-w-0 items-start gap-2 text-[var(--color-text-secondary)]">
            <MapPin size={16} className="mt-0.5 shrink-0" />
            {isUrl(event.place)
              ? <a href={event.place.trim()} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 break-all text-[var(--color-accent)] underline">{event.place}<ExternalLink size={12} className="shrink-0" /></a>
              : <span className="min-w-0 break-words">{event.place}</span>}
          </p>
        )}
        {event.trainer && <p className="text-[var(--color-text-secondary)]">Тренер: <b className="text-[var(--color-text)]">{event.trainer.name}</b></p>}
      </div>

      {event.description && <p className="whitespace-pre-wrap break-words rounded-lg bg-[var(--color-bg-hover)] px-3 py-2 leading-relaxed">{event.description}</p>}

      {(event.metricIds.length > 0 || (started && !cancelled)) && (
        <section className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2">
          <h3 className="flex items-center gap-2 text-[13px] font-semibold"><Target size={15} /> Эффективность</h3>
          {event.metricIds.length > 0
            ? <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-[var(--color-text-secondary)]">Показатели: <MetricChips ids={event.metricIds} metrics={metricMap} /></p>
            : <p className="text-[12.5px] text-[var(--color-text-muted)]">Показатели не привязаны — замеряются только цели записанных.</p>}
          <p className="text-[12px] text-[var(--color-text-muted)]">
            Замер: {event.measureBeforeDays} дн. до обучения против {event.measureAfterDays} дн. после; считается только у тех, кто был.
          </p>
          {!cancelled && <EffectSummaryLine s={event.effect} started={started} />}
        </section>
      )}

      <TrainingTestBlock eventId={event.id} canManage={canManage} cancelled={cancelled} />

      {canManage && (
        <div className={`flex min-w-0 flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[13px] ${event.calendar.state === 'failed' ? 'border-[var(--color-negative)]' : 'border-[var(--color-border)]'}`}>
          {event.calendar.state === 'synced' ? <CalendarCheck size={15} className="shrink-0 text-[var(--color-positive)]" /> : <CalendarX size={15} className="shrink-0" />}
          <span className="min-w-[12rem] flex-1 break-words">
            {event.calendar.state === 'synced'
              ? cancelled ? 'Убрано из календаря Битрикса' : 'В календаре тренера в Битриксе, записанные — участники'
              : event.calendar.state === 'pending' ? 'Календарь Битрикса: синхронизируется…'
              : <>Календарь Битрикса: не синхронизировано{event.calendar.error ? <span className="text-[var(--color-text-muted)]"> — {event.calendar.error}</span> : null}. Повторим автоматически.</>}
          </span>
          {event.calendar.state !== 'synced' && (
            <button type="button" onClick={onResync} disabled={busy}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 hover:bg-[var(--color-bg-hover)]">
              <RefreshCw size={14} /> Повторить
            </button>
          )}
        </div>
      )}

      {canManage && !cancelled && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onEdit} disabled={busy}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 hover:bg-[var(--color-bg-hover)]"><Pencil size={14} /> Изменить</button>
          <button type="button" onClick={onCancelEvent} disabled={busy}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-[var(--color-negative)] hover:bg-[var(--color-bg-hover)]"><Ban size={14} /> Отменить обучение</button>
        </div>
      )}

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold">
          <Users size={15} /> Записаны: {event.enrolledCount}{event.capacity != null ? ` из ${event.capacity}` : ''}
          {full && open && <span className="rounded-full bg-[var(--color-bg-hover)] px-2 py-0.5 text-[11px] font-normal">мест нет</span>}
        </h3>

        {canEnroll && open && (
          <div className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <SearchSelect
              options={options}
              value={pick}
              onChange={setPick}
              placeholder={managers.isLoading ? 'Загружаю менеджеров…' : options.length ? 'Выберите менеджера' : 'Некого записать'}
              searchPlaceholder="Поиск по имени или отделу"
              searchable
              ariaLabel="Менеджер для записи"
              disabled={full || busy || options.length === 0}
              className="min-h-11 min-w-0 flex-1"
            />
            <button type="button" disabled={!pick || full || busy}
              onClick={() => { onEnroll(Number(pick), goals, note); setPick(''); setNote(''); setGoals(event.metricIds); }}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 font-medium text-white disabled:opacity-50">
              <UserPlus size={15} /> Записать менеджера
            </button>
          </div>
          {pick && (
            <AvailabilityWarning req={{
              bitrixIds: [Number(pick)],
              slots: [{ start: event.startsAt, end: endOf(event.startsAt, event.durationMin).toISOString() }],
              exclude: { trainingEventId: event.id },
            }} />
          )}
          {pick && (
            <div className="flex min-w-0 flex-col gap-2 rounded-lg bg-[var(--color-bg-hover)] p-2">
              <label className="flex min-w-0 flex-col gap-1 text-[12.5px] text-[var(--color-text-secondary)]">
                Цель — какие показатели подтянуть
                <SearchMultiSelect options={metricOptions} value={goals} onChange={setGoals} allLabel="Без показателя"
                  unitLabel="показателя" searchPlaceholder="Поиск показателя" ariaLabel="Показатели цели" className="min-h-11 w-full min-w-0" />
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-[12.5px] text-[var(--color-text-secondary)]">
                Зачем отправляете
                <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={2000}
                  placeholder="Например: просел CR ППП, теряет клиентов после КП"
                  className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base sm:text-sm outline-none focus:border-[var(--color-accent)]" />
              </label>
            </div>
          )}
          </div>
        )}
        {error && <p className="text-[13px] text-[var(--color-negative)]">{error}</p>}

        {event.attendees.length === 0 && hidden <= 0 ? (
          <p className="text-[13px] text-[var(--color-text-muted)]">Пока никто не записан.</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {event.attendees.map(a => (
              <li key={a.manager.id} className="flex min-w-0 items-start justify-between gap-2 px-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="min-w-0 truncate font-medium">{a.manager.name}</span>
                    {started && !cancelled && <AttendanceBadge attended={a.attended} />}
                    {a.outcome && <OutcomeBadge outcome={a.outcome} />}
                  </span>
                  <span className="block truncate text-[12px] text-[var(--color-text-muted)]">
                    {[a.departmentName, a.enrolledBy ? `записал(а) ${a.enrolledBy}` : null, a.taskerTaskId ? 'из задачи' : null].filter(Boolean).join(' · ')}
                  </span>
                  {(a.goalMetricIds.length > 0 || a.goalNote) && (
                    <span className="flex min-w-0 flex-col gap-0.5 text-[12px] text-[var(--color-text-secondary)]">
                      {a.goalMetricIds.length > 0 && <span className="flex min-w-0 flex-wrap items-center gap-1">Цель: <MetricChips ids={a.goalMetricIds} metrics={metricMap} /></span>}
                      {a.goalNote && <span className="break-words">«{a.goalNote}»</span>}
                    </span>
                  )}
                  {canManage && started && !cancelled && (
                    <span className="flex flex-wrap gap-1.5" role="group" aria-label={`Посещение: ${a.manager.name}`}>
                      {([true, false] as const).map(v => (
                        <button key={String(v)} type="button" disabled={busy} aria-pressed={a.attended === v}
                          onClick={() => onAttendance(a.manager.id, a.attended === v ? null : v)}
                          className={`min-h-11 rounded-lg border px-3 text-[13px] ${a.attended === v
                            ? v ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-negative)] text-[var(--color-negative)]'
                            : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>
                          {v ? 'Был' : 'Не был'}
                        </button>
                      ))}
                    </span>
                  )}
                  <ResultLines results={a.results} metrics={metricMap} />
                </span>
                {a.canUnenroll && open && (
                  <button type="button" aria-label={`Отписать ${a.manager.name}`} title="Отписать" disabled={busy}
                    onClick={() => onUnenroll(a.manager.id)}
                    className="tap-target flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-negative)]">
                    <X size={16} />
                  </button>
                )}
              </li>
            ))}
            {hidden > 0 && (
              <li className="px-3 py-2 text-[12.5px] text-[var(--color-text-muted)]">
                и ещё {hidden} {plural(hidden, 'менеджер', 'менеджера', 'менеджеров')} из других отделов
              </li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}
