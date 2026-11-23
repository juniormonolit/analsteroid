'use client';
import { useMemo, useState } from 'react';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import type { TaskerMetric } from '../../types';
import type { TrainingEvent, TrainingEventInput } from '../types';
import { addDaysKey, mskDateKey, mskTime, mskToIso } from './format';
import { AvailabilityWarning } from '../../ui/shared/AvailabilityWarning';
import type { TaskerAvailabilityRequest } from '../../types';

const INPUT = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base sm:text-sm outline-none focus:border-[var(--color-accent)]';
const LABEL = 'flex min-w-0 flex-col gap-1 text-[13px] text-[var(--color-text-secondary)]';

/** Форма создания/правки обучения (внутри Drawer). Время — МСК. */
export function TrainingForm({
  initial,
  pending,
  error,
  onSubmit,
  onCancel,
  metrics,
}: {
  metrics: TaskerMetric[];
  initial?: TrainingEvent | null;
  pending: boolean;
  error: string | null;
  onSubmit: (input: TrainingEventInput) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [date, setDate] = useState(initial ? mskDateKey(initial.startsAt) : addDaysKey(mskDateKey(new Date()), 1));
  const [time, setTime] = useState(initial ? mskTime(initial.startsAt) : '11:00');
  const [duration, setDuration] = useState(String(initial?.durationMin ?? 60));
  const [place, setPlace] = useState(initial?.place ?? '');
  const [capacity, setCapacity] = useState(initial?.capacity ? String(initial.capacity) : '');
  const [metricIds, setMetricIds] = useState<string[]>(initial?.metricIds ?? []);
  const [beforeDays, setBeforeDays] = useState(String(initial?.measureBeforeDays ?? 14));
  const [afterDays, setAfterDays] = useState(String(initial?.measureAfterDays ?? 14));
  const [localErr, setLocalErr] = useState<string | null>(null);

  // Наложения (предупреждение): тренер (создатель — includeSelf) и уже записанные; само событие при правке — не конфликт.
  const availabilityReq = useMemo<TaskerAvailabilityRequest | null>(() => {
    const d = Number(duration);
    if (!date || !/^\d{2}:\d{2}$/.test(time) || !Number.isInteger(d) || d < 5) return null;
    const start = mskToIso(date, time);
    return {
      bitrixIds: [...(initial?.trainer ? [initial.trainer.id] : []), ...(initial?.attendees ?? []).map(a => a.manager.id)],
      includeSelf: !initial?.trainer,
      slots: [{ start, end: new Date(Date.parse(start) + d * 60_000).toISOString() }],
      exclude: initial ? { trainingEventId: initial.id } : undefined,
    };
  }, [date, time, duration, initial]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setLocalErr('Укажите тему');
    if (!date || !time) return setLocalErr('Укажите дату и время');
    const d = Number(duration);
    if (!Number.isInteger(d) || d < 5 || d > 600) return setLocalErr('Длительность — от 5 до 600 минут');
    const cap = capacity.trim() ? Number(capacity) : null;
    if (cap !== null && (!Number.isInteger(cap) || cap < 1)) return setLocalErr('Лимит мест — целое число от 1 или пусто');
    const bd = Number(beforeDays), ad = Number(afterDays);
    if (![bd, ad].every(n => Number.isInteger(n) && n >= 7 && n <= 90)) return setLocalErr('Окна замера — от 7 до 90 дней');
    setLocalErr(null);
    onSubmit({
      title: title.trim(),
      description,
      startsAt: mskToIso(date, time),
      durationMin: d,
      place: place.trim() || null,
      capacity: cap,
      metricIds,
      measureBeforeDays: bd,
      measureAfterDays: ad,
    });
  };

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3 text-sm">
      <label className={LABEL}>
        Тема
        <input className={INPUT} value={title} onChange={e => setTitle(e.target.value)} maxLength={200} placeholder="Например: работа с возражениями «дорого»" autoFocus />
      </label>
      <label className={LABEL}>
        Описание / программа
        <textarea className={`${INPUT} min-h-28 py-2`} value={description} onChange={e => setDescription(e.target.value)} rows={5} placeholder="Что разбираем, что подготовить" />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          Дата
          <input type="date" className={INPUT} value={date} onChange={e => setDate(e.target.value)} />
        </label>
        <label className={LABEL}>
          Начало (МСК)
          <input type="time" className={INPUT} value={time} onChange={e => setTime(e.target.value)} step={300} />
        </label>
        <label className={LABEL}>
          Длительность, мин
          <input type="number" inputMode="numeric" min={5} max={600} step={5} className={INPUT} value={duration} onChange={e => setDuration(e.target.value)} />
        </label>
        <label className={LABEL}>
          Лимит мест
          <input type="number" inputMode="numeric" min={1} className={INPUT} value={capacity} onChange={e => setCapacity(e.target.value)} placeholder="без лимита" />
        </label>
      </div>
      <AvailabilityWarning req={availabilityReq} />
      <label className={LABEL}>
        Место или ссылка
        <input className={INPUT} value={place} onChange={e => setPlace(e.target.value)} maxLength={500} placeholder="Переговорная 3 или https://…" />
      </label>
      <fieldset className="flex min-w-0 flex-col gap-3 rounded-lg border border-[var(--color-border)] p-3">
        <legend className="px-1 text-[13px] font-medium">Оценка эффективности</legend>
        <label className={LABEL}>
          Какие показатели должно подтянуть обучение
          <SearchMultiSelect options={metrics.map(m => ({ value: m.id, label: m.label }))} value={metricIds} onChange={setMetricIds}
            allLabel="Не выбраны" unitLabel="показателя" searchPlaceholder="Поиск показателя" ariaLabel="Показатели обучения"
            className="min-h-11 w-full min-w-0" />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={LABEL}>
            Окно «до», дней
            <input type="number" inputMode="numeric" min={7} max={90} className={INPUT} value={beforeDays} onChange={e => setBeforeDays(e.target.value)} />
          </label>
          <label className={LABEL}>
            Окно «после», дней
            <input type="number" inputMode="numeric" min={7} max={90} className={INPUT} value={afterDays} onChange={e => setAfterDays(e.target.value)} />
          </label>
        </div>
        <p className="text-[12px] text-[var(--color-text-muted)]">
          Через {afterDays || '…'} дн. после обучения система сравнит показатели посетивших с теми же днями до него и с отделом.
          Смена показателей или окон сбрасывает уже сделанные замеры.
        </p>
      </fieldset>
      {(localErr || error) && <p className="text-[13px] text-[var(--color-negative)]">{localErr ?? error}</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} disabled={pending}
          className="min-h-11 rounded-lg border border-[var(--color-border)] px-4 hover:bg-[var(--color-bg-hover)]">Отмена</button>
        <button type="submit" disabled={pending}
          className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 font-medium text-white disabled:opacity-50">
          {pending ? 'Сохраняю…' : initial ? 'Сохранить' : 'Создать обучение'}
        </button>
      </div>
    </form>
  );
}
