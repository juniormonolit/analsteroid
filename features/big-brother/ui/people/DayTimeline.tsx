'use client';
// Лента дня полосами по источникам: Монолитика / звонки / сделки / задачи / нет сигнала. Ось — рабочее окно сторожа
// (дефолт 9–18 МСК), расширяется до фактических сигналов. Отметка — минута события (активный отрезок Монолитики —
// 5 минут); бледные — «слабые» сигналы (изменение задачи без автора, пропущенный входящий), «в работе» не делают.
import { useMemo } from 'react';
import { BAND_LABEL, DAY_BANDS, GAP_MIN, type DayBand, type PersonDayResponse } from '../../engine/daily/types';
import { eventLabel, fmtTime, mskMinuteOfDay } from './shared';

const BAND_COLOR: Record<DayBand, string> = {
  mono: 'bg-sky-500', call: 'bg-emerald-500', deal: 'bg-amber-500', task: 'bg-violet-500',
};

export function DayTimeline({ data }: { data: PersonDayResponse }) {
  const { startMin, endMin, hours } = useMemo(() => {
    let s = data.windowStartHour * 60, e = data.windowEndHour * 60;
    for (const ev of data.events) {
      const m = mskMinuteOfDay(ev.at);
      if (m < s) s = Math.floor(m / 60) * 60;
      if (m + 5 > e) e = Math.min(24 * 60, Math.ceil((m + 5) / 60) * 60);
    }
    const hs: number[] = [];
    for (let h = s / 60; h <= e / 60; h++) hs.push(h);
    return { startMin: s, endMin: e, hours: hs };
  }, [data]);
  const span = endMin - startMin;
  const pct = (m: number) => `${((m - startMin) / span) * 100}%`;
  const labelEvery = hours.length > 13 ? 3 : hours.length > 8 ? 2 : 1;

  const byBand = useMemo(() => {
    const m = new Map<DayBand, PersonDayResponse['events']>();
    for (const b of DAY_BANDS) m.set(b, []);
    for (const ev of data.events) m.get(ev.band)?.push(ev);
    return m;
  }, [data]);

  const row = 'grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[110px_minmax(0,1fr)]';
  const track = 'relative h-6 overflow-hidden rounded bg-[var(--color-bg)]';

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {DAY_BANDS.map(b => {
        const list = byBand.get(b) ?? [];
        return (
          <div key={b} className={row}>
            <div className="truncate text-xs text-[var(--color-text-secondary)]">{BAND_LABEL[b]} <span className="tabular-nums text-[var(--color-text-muted)]">{list.filter(e => e.kind !== 'mono_minute' && !e.weak).reduce((s, e) => s + e.n, 0) || ''}</span></div>
            <div className={track}>
              {list.map((ev, i) => {
                const m = mskMinuteOfDay(ev.at);
                const w = ev.kind === 'mono_minute' ? 5 : 1;
                return (
                  <span key={i} title={`${fmtTime(ev.at)} · ${eventLabel(ev.kind, ev.action)}${ev.n > 1 ? ` ×${ev.n}` : ''}`}
                    className={`absolute top-0 h-full ${BAND_COLOR[b]} ${ev.weak ? 'opacity-30' : ev.kind === 'mono_minute' ? 'opacity-50' : ''}`}
                    style={{ left: pct(m), width: `max(2px, ${(w / span) * 100}%)` }} />
                );
              })}
            </div>
          </div>
        );
      })}
      <div className={row}>
        <div className="truncate text-xs text-[var(--color-text-secondary)]">Нет сигнала</div>
        <div className={track}>
          {data.gaps.map((g, i) => (
            <span key={i} title={`${fmtTime(g.from)}–${fmtTime(g.to)}: нет ни одного сигнала`}
              className="absolute top-0 h-full bg-[repeating-linear-gradient(45deg,var(--color-negative)_0_3px,transparent_3px_7px)] opacity-60"
              style={{ left: pct(mskMinuteOfDay(g.from)), width: `${((mskMinuteOfDay(g.to) - mskMinuteOfDay(g.from)) / span) * 100}%` }} />
          ))}
        </div>
      </div>
      <div className={row}>
        <div />
        <div className="relative h-4 text-[10px] tabular-nums text-[var(--color-text-muted)]">
          {hours.map((h, i) => i % labelEvery === 0 && (
            <span key={h} className="absolute -translate-x-1/2" style={{ left: pct(h * 60) }}>{h}</span>
          ))}
        </div>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Время МСК. Рабочее окно {data.windowStartHour}:00–{data.windowEndHour}:00; «нет сигнала» — разрывы от {GAP_MIN} минут внутри окна
        в рабочий день. Бледные отметки — изменения задач без автора и пропущенные входящие: в «работу» не засчитываются.
      </p>
      {data.events.length > 0 && (
        <details className="mt-1">
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-[var(--color-accent)]">Все события ({data.events.filter(e => e.kind !== 'mono_minute').length})</summary>
          <ul className="max-h-96 overflow-y-auto text-sm">
            {data.events.filter(e => e.kind !== 'mono_minute').map((ev, i) => (
              <li key={i} className={`flex gap-2 border-t border-[var(--color-border)] py-1 ${ev.weak ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text)]'}`}>
                <span className="w-11 shrink-0 tabular-nums">{fmtTime(ev.at)}</span>
                <span aria-hidden className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${BAND_COLOR[ev.band]}`} />
                <span className="min-w-0 break-words">{eventLabel(ev.kind, ev.action)}{ev.n > 1 ? ` ×${ev.n}` : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
