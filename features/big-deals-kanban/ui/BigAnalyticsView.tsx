'use client';
// Вкладка «Аналитика» канбана больших чеков (встреча 11.11: «сколько больших задач, продано, проебано, конверсия —
// подсветить низкую»). GET /api/big-deals-kanban/analytics?<фильтры доски>&from&to → BigAnalyticsResponse.
// Период — по дате создания задачи, по умолчанию 90 дней. Только для canManage.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import type { BigAnalyticsResponse, BigFilters, BigManagerStat } from '../engine/types';
import { FIELD } from './BigFiltersPanel';
import { filtersToParams } from './filters';
import { money } from './format';
import { mockAnalytics } from './mockBoard';

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`);
const ymd = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

type Key = 'name' | 'tasks' | 'open' | 'sold' | 'lost' | 'conversion' | 'soldSum' | 'callsPerTask';
const COLS: { key: Key; label: string; title?: string }[] = [
  { key: 'name', label: 'Менеджер' },
  { key: 'tasks', label: 'Задач', title: 'Больших задач, созданных за период' },
  { key: 'open', label: 'В работе' },
  { key: 'sold', label: 'Продано' },
  { key: 'lost', label: 'Не продано' },
  { key: 'conversion', label: 'Конверсия', title: 'Продано / (продано + не продано)' },
  { key: 'soldSum', label: 'Сумма продаж' },
  { key: 'callsPerTask', label: 'Звонков на задачу', title: 'Среднее звонков по сделке после постановки задачи' },
];
const val = (m: BigManagerStat, k: Key): number | string => (k === 'name' ? m.manager.name : (m[k] ?? -1));

export function BigAnalyticsView({ filters, mock }: { filters: BigFilters; mock: boolean }) {
  const def = useMemo(() => { const to = new Date(); const from = new Date(to.getTime() - 89 * 86_400_000); return { from: ymd(from), to: ymd(to) }; }, []);
  const [fromRaw, setFrom] = useUrlState('afrom', stringParam(''));
  const [toRaw, setTo] = useUrlState('ato', stringParam(''));
  const from = isDay(fromRaw) ? fromRaw : def.from;
  const to = isDay(toRaw) ? toRaw : def.to;
  const [sort, setSort] = useState<{ key: Key; desc: boolean }>({ key: 'tasks', desc: true });

  // Действуют проекты, товарные группы и менеджер доски (остальные фильтры — про текущее состояние доски, не про период).
  const scope: BigFilters = { groups: filters.groups, products: filters.products, manager: filters.manager };
  const qs = filtersToParams(scope);
  qs.set('from', from); qs.set('to', to);
  const { data, error, isLoading, isFetching } = useQuery<BigAnalyticsResponse, Error>({
    queryKey: ['big-deals-kanban-analytics', mock ? 'mock' : '', qs.toString()],
    queryFn: async () => {
      if (mock) return mockAnalytics(from, to);
      const r = await fetch(`/api/big-deals-kanban/analytics?${qs}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j as BigAnalyticsResponse;
    },
    staleTime: 60_000,
    placeholderData: prev => prev,
  });

  const rows = useMemo(() => {
    const list = [...(data?.managers ?? [])];
    list.sort((a, b) => {
      const x = val(a, sort.key), y = val(b, sort.key);
      const c = typeof x === 'string' ? x.localeCompare(String(y), 'ru') : x - (y as number);
      return sort.desc ? -c : c;
    });
    return list;
  }, [data, sort]);
  const avg = data?.avgConversion ?? null;
  const low = (m: BigManagerStat) => avg != null && m.conversion != null && m.conversion < avg;

  const cell = (m: BigManagerStat, k: Key, total = false) => {
    switch (k) {
      case 'name': return total ? 'Итого' : m.manager.name;
      case 'conversion': return pct(m.conversion);
      case 'soldSum': return m.soldSum ? money(m.soldSum) : '—';
      case 'callsPerTask': return m.callsPerTask == null ? '—' : m.callsPerTask.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
      default: return rub.format(m[k]);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3 px-4 pb-6 pt-3 sm:min-h-0 sm:flex-1 sm:overflow-y-auto sm:px-6">
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">Создана с
          <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} className={`${FIELD} w-auto bg-[var(--color-bg-surface)]`} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">по
          <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className={`${FIELD} w-auto bg-[var(--color-bg-surface)]`} />
        </label>
        {(fromRaw || toRaw) && (
          <button type="button" onClick={() => { setFrom(''); setTo(''); }} className="min-h-11 rounded-lg px-3 text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">90 дней</button>
        )}
        <p className="min-w-0 basis-full text-xs text-[var(--color-text-muted)] sm:basis-auto">
          По дате создания задачи. Действуют проекты, менеджер и товарные группы доски.
          {avg != null && <> Средняя конверсия — <b>{pct(avg)}</b>, ниже неё — <span className="text-[var(--color-negative)]">красным</span>.</>}
          {isFetching && data && ' Обновляю…'}
        </p>
      </div>

      {error && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{error.message}</div>}
      {isLoading && !data && !error && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Считаю по менеджерам…</div>}
      {data && (rows.length === 0 ? (
        <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">За период больших задач нет.</div>
      ) : (
        <div className="scroll-x rounded-xl border border-[var(--color-border)]">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-[var(--color-bg-surface)] text-xs text-[var(--color-text-muted)]">
              <tr>
                {COLS.map(c => {
                  const on = sort.key === c.key;
                  return (
                    <th key={c.key} scope="col" title={c.title} className={`px-3 py-1 font-medium ${c.key === 'name' ? 'sticky left-0 z-[1] bg-[var(--color-bg-surface)] text-left' : 'text-right'}`}>
                      <button type="button" onClick={() => setSort(s => ({ key: c.key, desc: s.key === c.key ? !s.desc : c.key !== 'name' }))}
                        className={`inline-flex min-h-11 items-center gap-0.5 ${on ? 'text-[var(--color-text)]' : ''}`}>
                        {c.label}{on && (sort.desc ? <ArrowDown size={12} aria-hidden /> : <ArrowUp size={12} aria-hidden />)}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map(m => (
                <tr key={m.manager.id} className="border-t border-[var(--color-border)]">
                  {COLS.map(c => (
                    <td key={c.key} className={`px-3 py-2 tabular-nums ${c.key === 'name' ? 'sticky left-0 bg-[var(--color-bg)] text-left' : 'text-right'} ${c.key === 'conversion' && low(m) ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-text)]'}`}>
                      {cell(m, c.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[var(--color-border-strong)] bg-[var(--color-bg-surface)] font-semibold">
                {COLS.map(c => (
                  <td key={c.key} className={`px-3 py-2 tabular-nums text-[var(--color-text)] ${c.key === 'name' ? 'sticky left-0 bg-[var(--color-bg-surface)] text-left' : 'text-right'}`}>
                    {cell(data.total, c.key, true)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      ))}
    </div>
  );
}
