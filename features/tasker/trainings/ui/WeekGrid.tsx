'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { TrainingEvent, TrainingSlot, TrainingSlotsResponse, TrainingsResponse } from '../types';
import { SLOTS_KEY, TRAININGS_KEY, getJson } from './api';
import { addDaysKey, ddmm, isoWeekday, mskDateKey, mskTime, surname, weekStart, WEEKDAYS_SHORT } from './format';
import type { TrainingFormPreset } from './TrainingForm';

/**
 * Сетка недели как таблица тренера: строки — время слотов, колонки — Пн–Пт (Сб/Вс — если есть слоты или события).
 * В ячейке — тема, отдел, фамилии. Пустой слот тренеру — «+», создание обучения с подставленным временем.
 * На телефоне — те же данные списком по дням (таблица из 5 колонок на 375px не читается).
 */
export function WeekGrid({ canManage, onOpen, onCreate }: {
  canManage: boolean;
  onOpen: (id: number) => void;
  onCreate: (preset: TrainingFormPreset) => void;
}) {
  const today = mskDateKey(new Date());
  const [monday, setMonday] = useState(() => weekStart(today));
  const sunday = addDaysKey(monday, 6);
  const slotsQ = useQuery({ queryKey: SLOTS_KEY, queryFn: () => getJson<TrainingSlotsResponse>('/api/tasker/trainings/slots') });
  const evQ = useQuery({
    queryKey: [...TRAININGS_KEY, 'week', monday],
    queryFn: () => getJson<TrainingsResponse>(`/api/tasker/trainings?from=${monday}&to=${sunday}`),
  });

  const slots = useMemo(() => (slotsQ.data?.slots ?? []).filter(s => s.active), [slotsQ.data]);
  const events = useMemo(() => evQ.data?.events ?? [], [evQ.data]);

  const grid = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => addDaysKey(monday, i));
    const used = new Set<number>([1, 2, 3, 4, 5]);
    for (const s of slots) used.add(s.weekday);
    for (const e of events) used.add(isoWeekday(mskDateKey(e.startsAt)));
    const cols = days.filter(d => used.has(isoWeekday(d)));
    const times = new Set<string>(slots.map(s => s.startTime));
    for (const e of events) times.add(mskTime(e.startsAt));
    const rows = [...times].sort();
    const slotAt = new Map<string, TrainingSlot>(slots.map(s => [`${s.weekday}|${s.startTime}`, s]));
    const evAt = new Map<string, TrainingEvent[]>();
    for (const e of events) {
      const k = `${mskDateKey(e.startsAt)}|${mskTime(e.startsAt)}`;
      evAt.set(k, [...(evAt.get(k) ?? []), e]);
    }
    return { cols, rows, slotAt, evAt };
  }, [monday, slots, events]);

  const loading = slotsQ.isLoading || evQ.isLoading;
  const error = (slotsQ.error ?? evQ.error) as Error | null;
  const nowMs = Date.now();

  const cell = (day: string, time: string, compact: boolean) => {
    const evs = grid.evAt.get(`${day}|${time}`) ?? [];
    const slot = grid.slotAt.get(`${isoWeekday(day)}|${time}`) ?? null;
    const startMs = Date.parse(`${day}T${time}:00+03:00`);
    if (evs.length) {
      return evs.map(e => <EventChip key={e.id} e={e} onOpen={() => onOpen(e.id)} />);
    }
    if (!slot) return compact ? null : <span aria-hidden className="text-[var(--color-text-muted)]">·</span>;
    const meta = [slot.label, slot.departmentLabel, slot.isOffline ? 'очно' : null].filter(Boolean).join(' · ');
    const canAdd = canManage && startMs > nowMs;
    return (
      <div className="flex min-w-0 items-start justify-between gap-1">
        <span className="min-w-0 break-words text-[11.5px] text-[var(--color-text-muted)]">{meta || (compact ? 'свободно' : '')}</span>
        {canAdd && (
          <button type="button" aria-label={`Обучение ${WEEKDAYS_SHORT[isoWeekday(day)]} ${ddmm(day)} ${time}`}
            onClick={() => onCreate({
              startsAt: new Date(startMs).toISOString(), durationMin: slot.durationMin, place: slot.place,
              slotId: slot.id, departmentLabel: slot.departmentLabel,
            })}
            className="tap-target hover-reveal inline-flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]">
            <Plus size={14} />
          </button>
        )}
      </div>
    );
  };

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button type="button" aria-label="Предыдущая неделя" onClick={() => setMonday(addDaysKey(monday, -7))}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]">
          <ChevronLeft size={16} />
        </button>
        <span className="min-w-0 text-sm font-medium tabular-nums">{ddmm(monday)} – {ddmm(sunday)}</span>
        <button type="button" aria-label="Следующая неделя" onClick={() => setMonday(addDaysKey(monday, 7))}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]">
          <ChevronRight size={16} />
        </button>
        {monday !== weekStart(today) && (
          <button type="button" onClick={() => setMonday(weekStart(today))}
            className="min-h-11 rounded-lg px-3 text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">Эта неделя</button>
        )}
        {slotsQ.data?.trainer && <span className="ml-auto min-w-0 truncate text-[12.5px] text-[var(--color-text-muted)]">Тренер: {slotsQ.data.trainer.name}</span>}
      </div>

      {loading ? (
        <p className="text-sm text-[var(--color-text-muted)]">Загружаю неделю…</p>
      ) : error ? (
        <p className="text-sm text-[var(--color-negative)]">{error.message}</p>
      ) : grid.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
          {canManage ? 'Сетка слотов пуста — задайте её во вкладке «Настройки».' : 'На этой неделе обучений нет.'}
        </div>
      ) : (
        <>
          {/* Планшет и шире — таблица как у тренера */}
          <div className="scroll-x hidden md:block">
            <table className="w-full min-w-[720px] table-fixed border-collapse text-[12.5px]">
              <thead>
                <tr>
                  <th className="w-16 border-b border-[var(--color-border)] px-2 py-2 text-left font-medium text-[var(--color-text-muted)]">Время</th>
                  {grid.cols.map(d => (
                    <th key={d} className={`border-b border-[var(--color-border)] px-2 py-2 text-left font-semibold ${d === today ? 'text-[var(--color-accent)]' : ''}`}>
                      {WEEKDAYS_SHORT[isoWeekday(d)]} <span className="font-normal text-[var(--color-text-muted)]">{ddmm(d)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map(t => (
                  <tr key={t} className="align-top">
                    <td className="border-b border-[var(--color-border)] px-2 py-2 font-semibold tabular-nums">{t}</td>
                    {grid.cols.map(d => (
                      <td key={d} className={`group border-b border-l border-[var(--color-border)] px-1.5 py-1.5 ${d === today ? 'bg-[color-mix(in_srgb,var(--color-accent)_5%,transparent)]' : ''}`}>
                        <div className="flex min-w-0 flex-col gap-1">{cell(d, t, false)}</div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Телефон — по дням */}
          <div className="flex min-w-0 flex-col gap-3 md:hidden">
            {grid.cols.map(d => (
              <div key={d} className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-[var(--color-border)] p-2.5">
                <h3 className={`text-[13px] font-semibold ${d === today ? 'text-[var(--color-accent)]' : ''}`}>
                  {WEEKDAYS_SHORT[isoWeekday(d)]} {ddmm(d)}{d === today ? ' · сегодня' : ''}
                </h3>
                {grid.rows.filter(t => grid.evAt.has(`${d}|${t}`) || grid.slotAt.has(`${isoWeekday(d)}|${t}`)).map(t => (
                  <div key={t} className="group flex min-w-0 items-start gap-2 border-t border-[var(--color-border)] pt-1.5">
                    <span className="w-11 shrink-0 pt-0.5 text-[12.5px] font-semibold tabular-nums">{t}</span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">{cell(d, t, true)}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function EventChip({ e, onOpen }: { e: TrainingEvent; onOpen: () => void }) {
  const names = e.attendees.map(a => surname(a.manager.name));
  const hidden = e.enrolledCount - names.length;
  return (
    <button type="button" onClick={onOpen}
      className="flex w-full min-w-0 flex-col gap-0.5 rounded-lg bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] px-2 py-1.5 text-left hover:bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)]">
      <span className="min-w-0 break-words font-medium leading-snug">{e.title}</span>
      {e.departmentLabel && <span className="min-w-0 truncate text-[11.5px] text-[var(--color-text-secondary)]">{e.departmentLabel}</span>}
      <span className="min-w-0 break-words text-[11.5px] text-[var(--color-text-muted)]">
        {names.length ? names.join(', ') : 'никто не записан'}{hidden > 0 ? ` +${hidden}` : ''}
      </span>
    </button>
  );
}
