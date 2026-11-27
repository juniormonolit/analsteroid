'use client';
// Предупреждение о наложении времени (POST /api/tasker/availability) — под полем времени в формах
// Задачника: собрание, обучение, запись на обучение, слот сессии задачи. Сам не запрещает; в форме задачи (hardBlock)
// подсвечивает пересечение с работой Задачника — её сервер не примет (собрание 26.11, п.3).
// Запрос — с задержкой 600 мс после последней правки (debounce) и кэшем React Query на минуту.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { TaskerAvailabilityRequest, TaskerAvailabilityResponse } from '../../types';
import { fmtTime, plural, shortName } from './format';

const DAY_FMT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', weekday: 'short', timeZone: 'Europe/Moscow' });

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** req = null — проверять нечего (нет людей или времени). */
export function useAvailability(req: TaskerAvailabilityRequest | null) {
  const key = useDebounced(req ? JSON.stringify(req) : '', 600);
  return useQuery<TaskerAvailabilityResponse, Error>({
    queryKey: ['tasker-availability', key],
    enabled: !!key,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const r = await fetch('/api/tasker/availability', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `Ошибка ${r.status}`);
      return j as TaskerAvailabilityResponse;
    },
  });
}

function span(c: { start: string; end: string; allDay?: boolean }, withDay: boolean): string {
  const day = withDay ? `${DAY_FMT.format(new Date(c.start))} ` : '';
  return c.allDay ? `${day}весь день` : `${day}${fmtTime(c.start)}–${fmtTime(c.end)}`;
}

/**
 * Блок под полем времени. multiSlot — проверяются несколько дат (вхождения серии): у каждого конфликта
 * показываем день.
 */
export function AvailabilityWarning({ req, multiSlot = false, className = '', hardBlock = false }: {
  req: TaskerAvailabilityRequest | null;
  multiSlot?: boolean;
  className?: string;
  /** Форма задачи (собрание 26.11, п.3): работа Задачника (задача/сессия/занятие) в это время — сервер откажет. */
  hardBlock?: boolean;
}) {
  const q = useAvailability(req);
  if (!req) return null;
  const base = `min-w-0 rounded-lg px-3 py-2 text-xs ${className}`;
  if (q.isLoading || (q.isFetching && !q.data)) {
    return <div className={`${base} flex items-center gap-1.5 text-[var(--color-text-muted)]`}><Loader2 size={13} className="animate-spin" aria-hidden />Проверяю занятость…</div>;
  }
  if (q.error) return <div className={`${base} text-[var(--color-text-muted)]`}>Занятость не проверена: {q.error.message}</div>;
  const d = q.data;
  if (!d) return null;
  const noBitrix = !d.bitrixChecked && <span className="text-[var(--color-text-muted)]"> · календарь Битрикса не проверен — учтены только события Монолитики</span>;

  if (d.busy.length === 0) {
    return (
      <div className={`${base} flex items-start gap-1.5 text-[var(--color-positive)]`} role="status">
        <CheckCircle2 size={13} className="mt-px shrink-0" aria-hidden />
        <span className="min-w-0">Пересечений нет · {d.checkedCount} {plural(d.checkedCount, 'человек проверен', 'человека проверено', 'человек проверено')}{noBitrix}</span>
      </div>
    );
  }

  const hard = hardBlock && d.busy.some(p => p.conflicts.some(c => c.source === 'task' || c.source === 'session' || c.source === 'training'));
  const first = (p: (typeof d.busy)[number]) => `${shortName(p.name)} — ${p.conflicts[0].title} ${span(p.conflicts[0], multiSlot)}`;
  const inline = d.busy.slice(0, 2).map(first).join('; ');
  return (
    <div className={`${base} bg-[var(--color-warning)]/10 text-[var(--color-text)]`} role="status">
      <div className="flex min-w-0 items-start gap-1.5">
        <AlertTriangle size={13} className="mt-px shrink-0 text-[var(--color-warning)]" aria-hidden />
        <span className="min-w-0 break-words">
          В это время {d.busy.length === 1 ? 'занят' : 'заняты'} <b>{d.busy.length} из {d.checkedCount}</b>: {inline}{d.busy.length > 2 ? ', …' : ''}.
          {' '}{hard
            ? <b className="text-[var(--color-negative)]">Это работа в Задачнике — в одно время две нельзя, сервер не поставит. Выберите свободное окно.</b>
            : hardBlock ? 'Это календарь Битрикса — сохранить можно, решите сами.' : 'Сохранить можно и так.'}{noBitrix}
        </span>
      </div>
      <details className="mt-1">
        <summary className="min-h-9 cursor-pointer select-none py-1.5 text-[var(--color-accent)]">Кто и чем занят</summary>
        <ul className="flex min-w-0 flex-col gap-1.5 pb-1">
          {d.busy.map(p => (
            <li key={p.id} className="min-w-0">
              <div className="font-semibold">{p.name}</div>
              <ul className="ml-3 list-disc">
                {p.conflicts.map((c, i) => (
                  <li key={i} className="min-w-0 break-words text-[var(--color-text-secondary)]">
                    {span(c, multiSlot)} · {c.title}{c.source === 'bitrix' ? ' (календарь Битрикса)' : ''}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
