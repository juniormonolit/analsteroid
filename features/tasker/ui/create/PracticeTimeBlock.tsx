'use client';
// Время «Практики» (собрание 26.11, ТЗ tz/2026-11-26_tasker.md п.3–5):
//  - время встречи обязательно (п.5); «без времени, только срок» — явной галочкой;
//  - несколько дат за одну постановку (п.4): «вт 15:00, чт 15:00» → по задаче на каждую дату;
//  - лента занятости исполнителя и менеджеров (п.3) на выбранный день и ближайшие рабочие дни: что занято
//    (задачи, сессии, занятия, календарь Битрикса) и свободные окна — клик подставляет время в активную дату.
//    Сервер всё равно отказывает при пересечении с работой Задачника; календарь Битрикса — предупреждение.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Plus, X } from 'lucide-react';
import type { TaskerBusyDaysResponse, TaskerBusyInterval } from '@/features/tasker/types';
import { fmtTime, shortName } from '../shared/format';
import { freeWindows } from '../../engine/when';

const INPUT = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50 sm:text-sm';
const MSK = 3 * 3600_000;
const WORKDAYS_AHEAD = 5;
const HARD = new Set(['task', 'session', 'training']);

const pad = (n: number) => String(n).padStart(2, '0');
/** ms → значение datetime-local в часовом поясе браузера (как его читает new Date(value)). */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const mskYmd = (ms: number) => new Date(ms + MSK).toISOString().slice(0, 10);
const addYmd = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isWeekend = (ymd: string) => { const w = new Date(`${ymd}T00:00:00Z`).getUTCDay(); return w === 0 || w === 6; };
const dayLabel = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

interface BusyItem extends TaskerBusyInterval { who: string }

export function PracticeTimeBlock({ slots, onSlots, noTime, onNoTime, durationMin, peopleIds, executorIds, children }: {
  /** Значения datetime-local; пустая строка — незаполненная дата. */
  slots: string[]; onSlots: (v: string[]) => void;
  noTime: boolean; onNoTime: (v: boolean) => void;
  durationMin: number;
  /** Все, чью занятость показываем: исполнитель(и) + менеджеры. */
  peopleIds: number[];
  executorIds: number[];
  children?: React.ReactNode;
}) {
  const [active, setActive] = useState(0);
  const filled = slots.map(s => { const t = s ? new Date(s).getTime() : NaN; return Number.isFinite(t) ? t : null; });
  const firstDay = filled.find((x): x is number => x != null);
  const from = firstDay ? mskYmd(firstDay) : mskYmd(Date.now());

  // 5 рабочих дней, начиная с выбранного (или сегодня).
  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = 0; out.length < WORKDAYS_AHEAD && d < 14; d++) {
      const ymd = addYmd(from, d);
      if (!isWeekend(ymd) || d === 0) out.push(ymd);
    }
    return out;
  }, [from]);
  const spanDays = days.length ? Math.round((Date.parse(`${days[days.length - 1]}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1 : 1;

  const ids = [...new Set(peopleIds)].sort((a, b) => a - b);
  const q = useQuery<TaskerBusyDaysResponse, Error>({
    queryKey: ['tasker', 'busy', ids.join(','), from, spanDays],
    enabled: !noTime && ids.length > 0,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const r = await fetch('/api/tasker/busy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bitrixIds: ids, from, days: spanDays }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `Ошибка ${r.status}`);
      return j as TaskerBusyDaysResponse;
    },
  });

  const items: BusyItem[] = useMemo(
    () => (q.data?.people ?? []).flatMap(p => p.busy.map(b => ({ ...b, who: executorIds.includes(p.id) ? `${shortName(p.name)} (исп.)` : shortName(p.name) }))),
    [q.data, executorIds],
  );

  const pick = (ms: number) => {
    const next = [...slots];
    const idx = next[active] !== undefined && !next[active] ? active : next.findIndex(s => !s);
    if (idx >= 0) next[idx] = toLocalInput(ms);
    else next.push(toLocalInput(ms));
    onSlots(next);
    setActive(idx >= 0 ? idx : next.length - 1);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-xs font-semibold text-[var(--color-text-muted)]">Когда встреча с менеджером</span>
      {!noTime && (
        <div className="flex min-w-0 flex-col gap-2">
          {slots.map((s, i) => (
            <div key={i} className="flex min-w-0 items-center gap-2">
              <input type="datetime-local" value={s} aria-label={`Дата и время ${i + 1}`}
                onFocus={() => setActive(i)}
                onChange={e => { const n = [...slots]; n[i] = e.target.value; onSlots(n); setActive(i); }}
                className={`${INPUT} sm:max-w-[260px] ${active === i && slots.length > 1 ? 'border-[var(--color-accent)]' : ''}`} />
              {slots.length > 1 && (
                <button type="button" aria-label="Убрать дату" onClick={() => { onSlots(slots.filter((_, j) => j !== i)); setActive(0); }}
                  className="tap-target inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
                  <X size={16} />
                </button>
              )}
            </div>
          ))}
          {slots.length < 10 && (
            <button type="button" onClick={() => { onSlots([...slots, '']); setActive(slots.length); }}
              className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
              <Plus size={15} /> Ещё дата (по задаче на каждую)
            </button>
          )}
        </div>
      )}
      <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-[var(--color-text)]">
        <input type="checkbox" checked={noTime} onChange={e => onNoTime(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--color-accent)]" />
        <span>Без времени, только срок <span className="text-[var(--color-text-muted)]">— менеджер не получит «с … до …», пересечения не проверяются</span></span>
      </label>

      {!noTime && ids.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--color-border)] p-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="text-xs font-semibold text-[var(--color-text-muted)]">Занятость исполнителя и менеджеров</span>
            {q.isFetching && <Loader2 size={13} className="animate-spin text-[var(--color-text-muted)]" aria-hidden />}
          </div>
          {q.error && <span className="text-xs text-[var(--color-negative)]">Не загрузилась: {q.error.message}</span>}
          {q.data && !q.data.bitrixChecked && <span className="text-[11px] text-[var(--color-text-muted)]">Календарь Битрикса не ответил — показана только работа в Монолитике</span>}
          {q.data && days.map(ymd => {
            const dayBusy = items.filter(b => mskYmd(Date.parse(b.start)) === ymd || (Date.parse(b.start) < Date.parse(`${ymd}T00:00:00+03:00`) && Date.parse(b.end) > Date.parse(`${ymd}T00:00:00+03:00`)));
            const windows = freeWindows(ymd, dayBusy.map(b => ({ start: Date.parse(b.start), end: Date.parse(b.end) })), durationMin);
            return (
              <div key={ymd} className="flex min-w-0 flex-col gap-1 border-t border-[var(--color-border)] pt-2 first:border-t-0 first:pt-0">
                <span className="text-[13px] font-semibold capitalize text-[var(--color-text)]">{dayLabel(ymd)}</span>
                {dayBusy.length > 0 && (
                  <ul className="flex min-w-0 flex-col gap-0.5">
                    {dayBusy.map((b, i) => (
                      <li key={i} className={`min-w-0 truncate text-[12px] ${HARD.has(b.source) ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}
                        title={`${b.who} · ${b.title}`}>
                        <span className="tabular-nums">{b.allDay ? 'весь день' : `${fmtTime(b.start)}–${fmtTime(b.end)}`}</span> · {b.who} · {b.title}
                        {b.source === 'bitrix' ? ' (Битрикс)' : ''}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {windows.length === 0
                    ? <span className="text-[12px] text-[var(--color-text-muted)]">Свободных окон на {durationMin} мин нет</span>
                    : windows.slice(0, 8).map(w => (
                      <button key={w.start} type="button" onClick={() => pick(w.start)}
                        title="Подставить это время"
                        className="min-h-9 rounded-lg border border-[var(--color-accent)] px-2.5 text-[12px] font-medium tabular-nums text-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]">
                        {fmtTime(new Date(w.start).toISOString())}–{fmtTime(new Date(w.end).toISOString())}
                      </button>
                    ))}
                </div>
              </div>
            );
          })}
          <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">
            Окно — время начала встречи; клик подставляет его в выбранную дату. Работа в Монолитике в одно время запрещена,
            события календаря Битрикса — на ваше усмотрение.
          </span>
        </div>
      )}
      {children}
    </div>
  );
}
