'use client';

// Таб «График работы» карточки менеджера (задача Иосифа 16.07) — по образу
// статистики Claude Code: плитки → календарь-хитмап → разбивка с процентами →
// строка-сравнение. Активность = звонки + изменения сделок (см. движок
// activityCalendar.ts). Окна: Всё (26 недель) / 30д / 7д.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ManagerActivityResult } from '@/features/manager-card/engine/activityCalendar';

type Win = 'all' | '30d' | '7d';

const WEEKDAY_LABELS = ['пн', '', 'ср', '', 'пт', '', ''];

function ruDate(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/** Уровень интенсивности 0-4 относительно максимума окна (как контрибуции на GitHub). */
function level(total: number, max: number): number {
  if (total <= 0) return 0;
  const t = total / Math.max(1, max);
  if (t > 0.75) return 4;
  if (t > 0.5) return 3;
  if (t > 0.25) return 2;
  return 1;
}

const LEVEL_BG = [
  'color-mix(in srgb, var(--color-border) 55%, transparent)',
  'color-mix(in srgb, var(--color-accent) 25%, transparent)',
  'color-mix(in srgb, var(--color-accent) 45%, transparent)',
  'color-mix(in srgb, var(--color-accent) 70%, transparent)',
  'var(--color-accent)',
];

function Heatmap({ days }: { days: ManagerActivityResult['days'] }) {
  const max = Math.max(1, ...days.map(d => d.calls + d.deals));
  // Колонки-недели с понедельника: паддинг пустыми ячейками до дня недели первого дня.
  const cells: ({ date: string; total: number; calls: number; deals: number } | null)[] = [];
  const firstDow = (new Date(`${days[0]?.date}T12:00:00Z`).getUTCDay() + 6) % 7; // 0=пн
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (const d of days) cells.push({ date: d.date, total: d.calls + d.deals, calls: d.calls, deals: d.deals });
  const weeks: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return (
    <div className="scroll-x">
      <div className="flex gap-1 items-start w-max">
        <div className="flex flex-col gap-[3px] pr-1 pt-0">
          {WEEKDAY_LABELS.map((l, i) => (
            <span key={i} className="h-[13px] text-[9px] leading-[13px] text-[var(--color-text-muted)] w-4 text-right">{l}</span>
          ))}
        </div>
        <div className="flex gap-[3px]">
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {Array.from({ length: 7 }).map((_, di) => {
                const c = week[di];
                return c ? (
                  <div
                    key={di}
                    className="w-[13px] h-[13px] rounded-[3px]"
                    style={{ backgroundColor: LEVEL_BG[level(c.total, max)] }}
                    title={`${ruDate(c.date)}: ${c.calls} звонков, ${c.deals} сделок`}
                  />
                ) : (
                  <div key={di} className="w-[13px] h-[13px]" />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ManagerActivityTab({ managerId }: { managerId: string }) {
  const [win, setWin] = useState<Win>('all');

  const { data, isLoading, error } = useQuery<ManagerActivityResult>({
    queryKey: ['manager-activity', managerId, win],
    queryFn: async () => {
      const res = await fetch('/api/manager-card/activity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ managerId, window: win }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Ошибка загрузки');
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const tile = (label: string, value: string) => (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-hover)] px-3 py-2.5">
      <div className="text-[11px] text-[var(--color-text-muted)]">{label}</div>
      <div className="text-[16px] font-extrabold text-[var(--color-text)] whitespace-nowrap">{value}</div>
    </div>
  );

  const t = data?.tiles;
  const dotColors: Record<string, string> = {
    calls_out: 'var(--color-accent)',
    calls_in: 'color-mix(in srgb, var(--color-accent) 55%, transparent)',
    deal_events: 'color-mix(in srgb, var(--color-accent) 30%, transparent)',
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[11px] font-bold tracking-wide uppercase text-[var(--color-text-muted)]">
          График работы{data ? ` · ${ruDate(data.meta.from)} — ${ruDate(data.meta.to)}` : ''}
        </span>
        <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
          {([['all', 'Всё'], ['30d', '30д'], ['7d', '7д']] as [Win, string][]).map(([k, l]) => (
            <button
              key={k}
              onClick={() => setWin(k)}
              className={`px-2.5 py-1.5 transition-colors ${win === k ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="text-sm text-red-500">{error instanceof Error ? error.message : 'Ошибка'}</p>
      ) : isLoading || !data ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-16 bg-[var(--color-border)] rounded-xl animate-pulse" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {tile('Рабочих дней', String(t!.workDays))}
            {tile('Звонков', t!.calls.toLocaleString('ru-RU'))}
            {tile('Сделок в работе', t!.dealsTouched.toLocaleString('ru-RU'))}
            {tile('Минут разговора', t!.talkMinutes.toLocaleString('ru-RU'))}
            {tile('Серия сейчас', `${t!.currentStreak} дн.`)}
            {tile('Лучшая серия', `${t!.longestStreak} дн.`)}
            {tile('Пик активности', t!.peakHour !== null ? `${t!.peakHour}:00` : '—')}
            {tile('Любимая категория', t!.favoriteCategory ?? '—')}
          </div>

          <Heatmap days={data.days} />

          <div className="flex flex-col gap-1.5">
            {data.breakdown.map(row => (
              <div key={row.key} className="flex items-center gap-2 text-[12px]">
                <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ backgroundColor: dotColors[row.key] }} />
                <span className="text-[var(--color-text)]">{row.label}</span>
                <span className="ml-auto text-[var(--color-text-muted)]">{row.count.toLocaleString('ru-RU')}</span>
                <span className="w-12 text-right font-bold text-[var(--color-text)]">{row.pct.toFixed(1)}%</span>
              </div>
            ))}
          </div>

          {data.percentile !== null && (
            <p className="text-[11.5px] text-[var(--color-text-muted)]">
              Активнее, чем ~{data.percentile}% менеджеров компании за этот период.
            </p>
          )}
        </>
      )}
    </div>
  );
}
