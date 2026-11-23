'use client';
// Форма серии регулярного собрания (создание и правка). Повтор: по будням / еженедельно по дням /
// раз в 2 недели / ежемесячно (число или n-й день недели). Участники — отделы целиком и/или люди.
import { useMemo, useState } from 'react';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import type { TaskerMeeting, TaskerMeetingInput, TaskerMeetingOptionsResponse, TaskerRecurrence } from '../../types';
import { DOW_SHORT, isoDow, nextDates, occurrenceStart, recurrenceLabel } from '../engine/recurrence';
import { AvailabilityWarning } from '../../ui/shared/AvailabilityWarning';
import type { TaskerAvailabilityRequest } from '../../types';
import { todayMsk } from '../../ui/shared/format';

const INPUT = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50 sm:text-sm';

function Field({ label, hint, children, className }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ''}`}>
      <span className="text-xs font-semibold text-[var(--color-text-muted)]">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">{hint}</span>}
    </div>
  );
}

type Kind = TaskerRecurrence['kind'];
const KIND_OPTIONS: SearchSelectOption[] = [
  { value: 'weekdays', label: 'Ежедневно по будням' },
  { value: 'weekly', label: 'Еженедельно по выбранным дням' },
  { value: 'biweekly', label: 'Раз в 2 недели' },
  { value: 'monthly_day', label: 'Ежемесячно — число месяца' },
  { value: 'monthly_nth', label: 'Ежемесячно — n-й день недели' },
];
const DURATIONS: SearchSelectOption[] = [15, 30, 45, 60, 90, 120].map(m => ({ value: String(m), label: `${m} мин` }));
const MONTH_DAYS: SearchSelectOption[] = Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}-го числа` }));
const NTH_OPTIONS: SearchSelectOption[] = [
  { value: '1', label: 'Первый' }, { value: '2', label: 'Второй' }, { value: '3', label: 'Третий' },
  { value: '4', label: 'Четвёртый' }, { value: '-1', label: 'Последний' },
];
const WEEKDAY_OPTIONS: SearchSelectOption[] = [1, 2, 3, 4, 5, 6, 7].map(d => ({
  value: String(d), label: ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'][d],
}));

export function MeetingForm({ initial, options, pending, error, onSubmit, onCancel }: {
  initial: TaskerMeeting | null;
  options: TaskerMeetingOptionsResponse | undefined;
  pending: boolean;
  error: string | null;
  onSubmit: (input: TaskerMeetingInput) => void;
  onCancel: () => void;
}) {
  const today = todayMsk();
  const r0 = initial?.recurrence;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [agenda, setAgenda] = useState(initial?.agenda ?? '');
  const [organizerPick, setOrganizer] = useState(initial ? String(initial.organizer.id) : '');
  // Справочник мог догрузиться после открытия формы — по умолчанию организатор = создатель.
  const organizer = organizerPick || (options?.selfBitrixId ? String(options.selfBitrixId) : '');
  const [startDate, setStartDate] = useState(initial?.startDate ?? today);
  const [startTime, setStartTime] = useState(initial?.startTime ?? '10:00');
  const [duration, setDuration] = useState(String(initial?.durationMin ?? 30));
  const [kind, setKind] = useState<Kind>(r0?.kind ?? 'weekly');
  const [days, setDays] = useState<number[]>(r0 && (r0.kind === 'weekly' || r0.kind === 'biweekly') ? r0.days : [isoDow(startDate) <= 5 ? isoDow(startDate) : 1]);
  const [monthDay, setMonthDay] = useState(String(r0?.kind === 'monthly_day' ? r0.day : Math.min(28, Number(startDate.slice(8, 10)))));
  const [nth, setNth] = useState(String(r0?.kind === 'monthly_nth' ? r0.nth : 1));
  const [weekday, setWeekday] = useState(String(r0?.kind === 'monthly_nth' ? r0.weekday : 1));
  const [untilDate, setUntilDate] = useState(initial?.untilDate ?? '');
  const [place, setPlace] = useState(initial?.place ?? '');
  const [deptIds, setDeptIds] = useState<string[]>(initial?.departments.map(d => d.id) ?? []);
  const [personIds, setPersonIds] = useState<string[]>(initial?.people.map(p => String(p.id)) ?? []);

  const recurrence: TaskerRecurrence = kind === 'weekdays' ? { kind }
    : kind === 'weekly' || kind === 'biweekly' ? { kind, days }
      : kind === 'monthly_day' ? { kind, day: Number(monthDay) }
        : { kind, nth: Number(nth) as 1 | 2 | 3 | 4 | -1, weekday: Number(weekday) };

  // Варианты: справочник + уже выбранные (SearchMultiSelect не показывает значения вне options).
  const deptOptions = useMemo<SearchSelectOption[]>(() => {
    const m = new Map((options?.departments ?? []).map(d => [d.id, { value: d.id, label: d.name, hint: d.path }]));
    for (const d of initial?.departments ?? []) if (!m.has(d.id)) m.set(d.id, { value: d.id, label: d.name, hint: null });
    return [...m.values()];
  }, [options, initial]);
  const peopleOptions = useMemo<SearchSelectOption[]>(() => {
    const m = new Map((options?.people ?? []).map(p => [String(p.id), { value: String(p.id), label: p.name, hint: p.deptName }]));
    for (const p of [...(initial?.people ?? []), ...(initial ? [initial.organizer] : [])]) if (!m.has(String(p.id))) m.set(String(p.id), { value: String(p.id), label: p.name, hint: null });
    return [...m.values()];
  }, [options, initial]);

  // Наложения: ближайшие 4 встречи серии × организатор, люди и отделы целиком; своя серия при правке — не конфликт.
  const availabilityReq = useMemo<TaskerAvailabilityRequest | null>(() => {
    if (!startDate || !/^\d{2}:\d{2}$/.test(startTime) || (!deptIds.length && !personIds.length && !organizer)) return null;
    if ((kind === 'weekly' || kind === 'biweekly') && !days.length) return null;
    const from = startDate > today ? startDate : today;
    const dates = nextDates({ startDate, untilDate: untilDate || null, recurrence }, from, 4);
    if (!dates.length) return null;
    const dur = Number(duration) * 60_000;
    return {
      bitrixIds: [...(organizer ? [Number(organizer)] : []), ...personIds.map(Number)],
      departmentIds: deptIds,
      slots: dates.map(d => { const st = occurrenceStart(d, startTime); return { start: st, end: new Date(Date.parse(st) + dur).toISOString() }; }),
      exclude: initial ? { meetingId: initial.id } : undefined,
    };
    // recurrence собирается из kind/days/monthDay/nth/weekday — они и в зависимостях.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, startTime, duration, kind, days, monthDay, nth, weekday, untilDate, deptIds, personIds, organizer, initial, today]);

  const problems: string[] = [];
  if (!title.trim()) problems.push('название');
  if ((kind === 'weekly' || kind === 'biweekly') && days.length === 0) problems.push('дни недели');
  if (!deptIds.length && !personIds.length) problems.push('участники');
  if (untilDate && untilDate < startDate) problems.push('дата окончания раньше начала');
  if (!organizer) problems.push('организатор');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (problems.length) return;
    onSubmit({
      title: title.trim(), agenda, startDate, startTime, durationMin: Number(duration), recurrence,
      untilDate: untilDate || null, place: place.trim() || null, departmentIds: deptIds, personIds: personIds.map(Number),
      organizerId: organizer ? Number(organizer) : null,
    });
  };

  const toggleDay = (d: number) => setDays(cur => (cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d].sort()));

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      <Field label="Название">
        <input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} placeholder="Планёрка отдела" className={INPUT} required />
      </Field>
      <Field label="Повестка" hint="Уйдёт в описание события календаря Битрикса">
        <textarea value={agenda} onChange={e => setAgenda(e.target.value)} rows={3} className={`${INPUT} py-2`} />
      </Field>

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Первая встреча">
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className={INPUT} required />
        </Field>
        <Field label="Время (МСК)">
          <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className={INPUT} required />
        </Field>
        <Field label="Длительность">
          <SearchSelect options={DURATIONS} value={duration} onChange={setDuration} ariaLabel="Длительность" className="min-h-11 w-full" />
        </Field>
      </div>

      <Field label="Повтор" hint={recurrenceLabel(recurrence, startTime)}>
        <SearchSelect options={KIND_OPTIONS} value={kind} onChange={v => setKind(v as Kind)} ariaLabel="Повтор" className="min-h-11 w-full" />
      </Field>
      {(kind === 'weekly' || kind === 'biweekly') && (
        <div className="flex min-w-0 flex-wrap gap-1.5" role="group" aria-label="Дни недели">
          {[1, 2, 3, 4, 5, 6, 7].map(d => (
            <button key={d} type="button" aria-pressed={days.includes(d)} onClick={() => toggleDay(d)}
              className={`min-h-11 min-w-11 rounded-lg border px-2 text-sm ${days.includes(d) ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
              {DOW_SHORT[d]}
            </button>
          ))}
        </div>
      )}
      {kind === 'monthly_day' && (
        <Field label="Число месяца" hint="29–31 есть не в каждом месяце — до 28-го">
          <SearchSelect options={MONTH_DAYS} value={monthDay} onChange={setMonthDay} ariaLabel="Число месяца" className="min-h-11 w-full" />
        </Field>
      )}
      {kind === 'monthly_nth' && (
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Какой по счёту">
            <SearchSelect options={NTH_OPTIONS} value={nth} onChange={setNth} ariaLabel="Неделя месяца" className="min-h-11 w-full" />
          </Field>
          <Field label="День недели">
            <SearchSelect options={WEEKDAY_OPTIONS} value={weekday} onChange={setWeekday} ariaLabel="День недели" className="min-h-11 w-full" />
          </Field>
          <p className="text-[11px] leading-snug text-[var(--color-text-muted)] sm:col-span-2">
            Битрикс не умеет такой повтор через REST: в календаре стоит ближайшая встреча, после неё Монолитика сама переставляет событие на следующую.
          </p>
        </div>
      )}

      <AvailabilityWarning req={availabilityReq} multiSlot />

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Повторять до (необязательно)">
          <input type="date" value={untilDate} min={startDate} onChange={e => setUntilDate(e.target.value)} className={INPUT} />
        </Field>
        <Field label="Место или ссылка">
          <input value={place} onChange={e => setPlace(e.target.value)} maxLength={500} placeholder="Переговорная / ссылка на звонок" className={INPUT} />
        </Field>
      </div>

      {options?.canPickOrganizer && (
        <Field label="Организатор" hint="Событие встанет в его календарь Битрикса">
          <SearchSelect options={peopleOptions} value={organizer} onChange={setOrganizer} ariaLabel="Организатор" className="min-h-11 w-full" searchable />
        </Field>
      )}
      <Field label="Отделы целиком" hint="Все сотрудники отдела и его подотделов — состав обновляется сам">
        <SearchMultiSelect options={deptOptions} value={deptIds} onChange={setDeptIds} allLabel="Не выбраны" unitLabel="отд." ariaLabel="Отделы" className="min-h-11 w-full" />
      </Field>
      <Field label="Отдельные люди">
        <SearchMultiSelect options={peopleOptions} value={personIds} onChange={setPersonIds} allLabel="Не выбраны" unitLabel="чел." ariaLabel="Люди" className="min-h-11 w-full" />
      </Field>

      {error && <div role="alert" className="rounded-lg bg-[var(--color-negative)]/10 p-3 text-sm text-[var(--color-negative)]">{error}</div>}
      {problems.length > 0 && <div className="text-xs text-[var(--color-text-muted)]">Не заполнено: {problems.join(', ')}</div>}

      <div className="flex min-w-0 flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className="min-h-11 rounded-lg border border-[var(--color-border)] px-4 text-sm hover:bg-[var(--color-bg-hover)]">Отмена</button>
        <button type="submit" disabled={pending || problems.length > 0}
          className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
          {pending ? 'Сохраняю…' : initial ? 'Сохранить серию' : 'Создать собрание'}
        </button>
      </div>
    </form>
  );
}
