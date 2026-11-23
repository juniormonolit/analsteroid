'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, CalendarCheck, CalendarX, MapPin, Pencil, RefreshCw, UserPlus, Users, X, Ban, ExternalLink } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import type { TrainingEvent, TrainingManagersResponse } from '../types';
import { getJson } from './api';
import { durationLabel, endOf, isUrl, mskDayLabel, mskTime, plural } from './format';

/** Содержимое карточки обучения (в Drawer): детали, записанные, запись/отписка, действия тренера. */
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
}: {
  event: TrainingEvent;
  canManage: boolean;
  canEnroll: boolean;
  busy: boolean;
  error: string | null;
  onEnroll: (managerId: number) => void;
  onUnenroll: (managerId: number) => void;
  onEdit: () => void;
  onCancelEvent: () => void;
  onResync: () => void;
}) {
  const [pick, setPick] = useState('');
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
              onClick={() => { onEnroll(Number(pick)); setPick(''); }}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 font-medium text-white disabled:opacity-50">
              <UserPlus size={15} /> Записать менеджера
            </button>
          </div>
        )}
        {error && <p className="text-[13px] text-[var(--color-negative)]">{error}</p>}

        {event.attendees.length === 0 && hidden <= 0 ? (
          <p className="text-[13px] text-[var(--color-text-muted)]">Пока никто не записан.</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {event.attendees.map(a => (
              <li key={a.manager.id} className="flex min-w-0 items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{a.manager.name}</span>
                  <span className="block truncate text-[12px] text-[var(--color-text-muted)]">
                    {[a.departmentName, a.enrolledBy ? `записал(а) ${a.enrolledBy}` : null, a.taskerTaskId ? 'из задачи' : null].filter(Boolean).join(' · ')}
                  </span>
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
