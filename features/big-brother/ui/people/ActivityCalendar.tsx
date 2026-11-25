'use client';
// Календарь активности за год в стиле GitHub: колонка — неделя (пн…вс), клетка — день. Цвет — число 5-минутных
// отрезков с сигналом из любого источника (activity_daily.counts.buckets). Серая клетка — рабочий день без единого
// сигнала, пустая рамка — выходной без сигналов или день до начала сборки агрегата. Клик — открыть день в ленте.
// Широкая сетка — в .scroll-x, при открытии прокручена к сегодняшнему дню.
import { useEffect, useMemo, useRef } from 'react';
import type { CalendarDayDto, PersonCalendarResponse } from '../../engine/daily/types';
import { fmtMin, shiftDate } from './shared';

const LEVELS = ['bg-emerald-200', 'bg-emerald-400', 'bg-emerald-600', 'bg-emerald-800'];
/** Пороги в 5-мин отрезках: до 1 ч, до 3 ч, до 6 ч, больше. */
const level = (b: number) => (b <= 12 ? 0 : b <= 36 ? 1 : b <= 72 ? 2 : 3);
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const isoDow = (date: string) => { const d = new Date(`${date}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };

function cellTitle(date: string, d: CalendarDayDto | undefined): string {
  const head = new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long' });
  if (!d) return `${head}: нет данных`;
  if (!d.inWork) return `${head}: ни одного сигнала${d.isWorkday === false ? ' (выходной)' : ''}`;
  return `${head}: активно ~${fmtMin(d.buckets * 5)}; Монолитика ${fmtMin(d.monoMinutes)}, звонков ${d.calls}, сделок ${d.deals}, задач ${d.tasks}`;
}

export function ActivityCalendar({ data, selected, onPick }: { data: PersonCalendarResponse; selected: string; onPick: (d: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const byDate = useMemo(() => new Map(data.days.map(d => [d.date, d])), [data]);
  const weeks = useMemo(() => {
    if (!data.to) return [] as string[][];
    const start = shiftDate(data.from, -(isoDow(data.from) - 1)); // понедельник
    const out: string[][] = [];
    for (let d = start; d <= data.to; d = shiftDate(d, 7)) {
      out.push(Array.from({ length: 7 }, (_, i) => shiftDate(d, i)));
    }
    return out;
  }, [data]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [weeks.length]);

  const active = data.days.filter(d => d.inWork).length;
  const silentWork = data.days.filter(d => !d.inWork && d.isWorkday).length;

  if (!data.days.length) {
    return <p className="text-sm text-[var(--color-text-muted)]">Дневной агрегат по этому человеку ещё не собран — календарь заполнится после ночной сборки.</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div ref={scroller} className="scroll-x pb-1">
        <div className="inline-flex flex-col gap-1">
          <div className="flex gap-[3px] pl-6 text-[10px] text-[var(--color-text-muted)]">
            {weeks.map((w, i) => {
              const monthStart = w.find(d => d.slice(8) === '01');
              return <span key={i} className="w-[11px] overflow-visible whitespace-nowrap">{monthStart ? MONTHS[+monthStart.slice(5, 7) - 1] : ''}</span>;
            })}
          </div>
          <div className="flex gap-[3px]">
            <div className="flex w-5 flex-col gap-[3px] text-[10px] leading-[11px] text-[var(--color-text-muted)]">
              {['пн', '', 'ср', '', 'пт', '', ''].map((l, i) => <span key={i} className="h-[11px]">{l}</span>)}
            </div>
            {weeks.map((w, wi) => (
              <div key={wi} className="flex flex-col gap-[3px]">
                {w.map(date => {
                  if (date < data.from || date > data.to) return <span key={date} className="h-[11px] w-[11px]" />;
                  const d = byDate.get(date);
                  const cls = d?.inWork ? LEVELS[level(d.buckets)]
                    : d && d.isWorkday ? 'bg-[var(--color-border-strong)]'
                      : 'border border-[var(--color-border)]';
                  return (
                    <button key={date} type="button" title={cellTitle(date, d)} aria-label={cellTitle(date, d)}
                      onClick={() => onPick(date)}
                      className={`h-[11px] w-[11px] rounded-[2px] ${cls} ${date === selected ? 'ring-2 ring-[var(--color-accent)] ring-offset-1 ring-offset-[var(--color-bg-surface)]' : ''}`} />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
        <span>Дней с сигналами: {active} · рабочих без сигнала: {silentWork}</span>
        <span className="flex items-center gap-1">
          меньше
          <span className="h-[11px] w-[11px] rounded-[2px] bg-[var(--color-border-strong)]" title="Рабочий день без сигнала" />
          {LEVELS.map(c => <span key={c} className={`h-[11px] w-[11px] rounded-[2px] ${c}`} />)}
          больше
        </span>
      </div>
    </div>
  );
}
