'use client';
// Карточка человека: итоги дня, лента дня полосами по источникам, календарь активности за год.
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { ROLE_LABEL, type PersonCalendarResponse, type PersonDayResponse } from '../../engine/daily/types';
import { ActivityCalendar } from './ActivityCalendar';
import { DateBar } from './DateBar';
import { DayTimeline } from './DayTimeline';
import { CARD, callsOf, dealsOf, fmtDateLong, fmtMin, fmtTime, servicesOf } from './shared';

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
  return j as T;
}

function Tile({ label, value, hint, bad }: { label: string; value: string; hint?: string; bad?: boolean }) {
  return (
    <div className={`${CARD} min-w-0 p-3`}>
      <div className="text-xs text-[var(--color-text-secondary)]">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${bad ? 'text-[var(--color-negative)]' : 'text-[var(--color-text)]'}`}>{value}</div>
      {hint && <div className="truncate text-xs text-[var(--color-text-muted)]">{hint}</div>}
    </div>
  );
}

export function PersonCard({ id, date, onDate, onBack }: { id: string; date: string; onDate: (d: string) => void; onBack: () => void }) {
  const dayQ = useQuery<PersonDayResponse, Error>({
    queryKey: ['big-brother-person-day', id, date],
    queryFn: () => getJson(`/api/big-brother/people/${id}/day?date=${date}`),
    staleTime: 60_000,
    placeholderData: prev => (prev?.person.id === id ? prev : undefined),
  });
  const calQ = useQuery<PersonCalendarResponse, Error>({
    queryKey: ['big-brother-person-cal', id],
    queryFn: () => getJson(`/api/big-brother/people/${id}`),
    staleTime: 5 * 60_000,
  });
  const d = dayQ.data;
  const c = d?.day.counts ?? {};

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button type="button" onClick={onBack}
          className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
          <ArrowLeft size={16} /> К списку
        </button>
        <DateBar date={date} onChange={onDate} />
      </div>

      {d && (
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-[var(--color-text)]">{d.person.name}</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {[ROLE_LABEL[d.person.role], d.person.departmentName, d.person.ropName && `РОП ${d.person.ropName}`].filter(Boolean).join(' · ')}
          </p>
          <p className="text-xs text-[var(--color-text-muted)]">
            {fmtDateLong(d.date)} · {d.day.isWorkday ? 'рабочий день' : 'выходной по производственному календарю'}
            {' · '}{d.day.inWork ? 'в работе' : 'ни одного сигнала'}
          </p>
        </div>
      )}
      {dayQ.error && <div className={`${CARD} p-4 text-sm text-[var(--color-negative)]`}>{dayQ.error.message}</div>}
      {dayQ.isLoading && !d && <div className={`${CARD} p-4 text-sm text-[var(--color-text-muted)]`}>Собираю ленту дня…</div>}

      {d && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Первый — последний" value={d.day.inWork ? `${fmtTime(d.day.firstSignalAt)}–${fmtTime(d.day.lastSignalAt)}` : '—'} />
            <Tile label="Монолитика" value={fmtMin(d.day.monoMinutes)} hint={`действий: ${servicesOf(c)}`} />
            <Tile label="Звонки" value={String(callsOf(c))}
              hint={`дозвон ${c['call.out_reached'] ?? 0} · вход. ${c['call.in'] ?? 0} · проп. ${c['call.in_missed'] ?? 0}`} />
            <Tile label="Сделки" value={String(dealsOf(c))} hint={`стадий ${c.deal_stage ?? 0} · новых ${c.deal_new ?? 0}`} />
            <Tile label="Задачи" value={`${d.day.tasksCreated} / ${d.day.tasksClosed}`} hint="поставил / закрыл свои" />
            <Tile label="Просрочено" value={String(d.day.tasksOverdue)} hint="на конец дня" bad={d.day.tasksOverdue > 0} />
          </div>

          <section className={`${CARD} min-w-0 p-3`}>
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-text)]">Лента дня</h3>
            <DayTimeline data={d} />
            {d.failedSources.length > 0 && (
              <p className="mt-2 text-xs text-[var(--color-negative)]">Не прочитались источники: {d.failedSources.join(', ')} — лента неполная.</p>
            )}
          </section>
        </>
      )}

      <section className={`${CARD} min-w-0 p-3`}>
        <h3 className="mb-2 text-sm font-semibold text-[var(--color-text)]">Активность по дням</h3>
        {calQ.error && <p className="text-sm text-[var(--color-negative)]">{calQ.error.message}</p>}
        {calQ.data && <ActivityCalendar data={calQ.data} selected={date} onPick={onDate} />}
        {calQ.isLoading && <p className="text-sm text-[var(--color-text-muted)]">Загружаю календарь…</p>}
      </section>
    </div>
  );
}
