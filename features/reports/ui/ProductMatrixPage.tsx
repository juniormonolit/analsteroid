'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Filter, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { PeriodRangeControls } from './FilterBar';
import { defaultPeriod, ALL_TIME_START, type DateRange } from '@/lib/period';
import type { MatrixCell } from '@/features/reports/engine/productMatrix';

// «Товарная матрица» (задача владельца 10.08): квадрат «категория → категория»,
// в ячейке — вероятность, что следующая покупка после вертикальной категории
// будет из горизонтальной. Определения — в шапке engine/productMatrix.ts.
//
// Фильтр категорий режет ТОЛЬКО видимые строки/колонки: вероятности считаются
// от всех переходов, поэтому строка при активном фильтре может суммироваться
// не в 100 % — это честно и означает «остальное ушло в скрытые категории».

interface MatrixResponse {
  categories: string[];
  cells: MatrixCell[];
  rowTotals: Record<string, number>;
}

/** Фон ячейки: прозрачный → акцент по мере роста вероятности. Кап на 60 % —
 *  выше почти не бывает (диагональ лояльных категорий), а без капа вся палитра
 *  уходила бы на редкие выбросы и середина сливалась. */
function heatBg(pct: number): string {
  const t = Math.min(pct / 60, 1);
  return `color-mix(in srgb, var(--color-accent) ${Math.round(t * 55)}%, transparent)`;
}

export function ProductMatrixPage() {
  // Дефолт «всё время»: матрица переходов статистически осмысленнее на длинной
  // истории; узкий период — осознанный выбор («куда возвращались в июле»).
  const [period, setPeriod] = useState<DateRange>(() => ({ from: ALL_TIME_START, to: defaultPeriod().to }));
  const [comparison, setComparison] = useState<DateRange>(defaultPeriod);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // пусто = все

  const { data, isLoading, error } = useQuery<MatrixResponse>({
    queryKey: ['product-matrix', period.from.toISOString(), period.to.toISOString()],
    queryFn: async () => {
      const res = await fetch('/api/reports/product-matrix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: { from: period.from.toISOString(), to: period.to.toISOString() } }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const allCats = useMemo(() => data?.categories ?? [], [data]);
  const shown = useMemo(
    () => (selected.size === 0 ? allCats : allCats.filter(c => selected.has(c))),
    [allCats, selected],
  );
  const cellMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of data?.cells ?? []) m.set(`${c.from}→${c.to}`, c.n);
    return m;
  }, [data]);

  function toggle(cat: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden flex flex-col">
      <div className="px-3 sm:px-6 py-3 border-b border-[var(--color-border)]">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Товарная матрица</h1>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
          Вероятность следующей покупки: строка — что купили, колонка — что купят следующим.
          Период режет по закрывающей покупке пары; предыдущая берётся из всей истории.
        </p>
      </div>

      <div className="flex items-center gap-2 px-3 sm:px-6 py-2 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex-wrap">
        <PeriodRangeControls
          period={period}
          comparison={comparison}
          onPeriodChange={setPeriod}
          onComparisonChange={setComparison}
          showComparison={false}
        />
        <Popover
          trigger={
            <button className="min-h-11 sm:min-h-0 sm:py-1.5 px-3 flex items-center gap-1.5 border border-[var(--color-border)] rounded-lg text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors">
              <Filter size={14} />
              Категории
              {selected.size > 0 && (
                <span className="px-1.5 py-0.5 text-[11px] rounded-full bg-[var(--color-accent)] text-[var(--color-text-inverse)]">
                  {selected.size}
                </span>
              )}
            </button>
          }
        >
          <div className="max-h-[60vh] overflow-y-auto p-2 w-72 max-w-[94vw]">
            <div className="flex items-center justify-between px-1 pb-2">
              <span className="text-xs font-medium text-[var(--color-text-muted)]">
                {selected.size === 0 ? 'Показаны все категории' : `Выбрано: ${selected.size}`}
              </span>
              {selected.size > 0 && (
                <button
                  onClick={() => setSelected(new Set())}
                  className="tap-target text-xs text-[var(--color-accent)] hover:underline flex items-center gap-0.5"
                >
                  <X size={12} /> Сбросить
                </button>
              )}
            </div>
            {allCats.map(cat => (
              <label key={cat} className="flex items-center gap-2 px-1 py-1.5 text-sm text-[var(--color-text)] cursor-pointer hover:bg-[var(--color-bg-hover)] rounded">
                <input
                  type="checkbox"
                  checked={selected.size === 0 || selected.has(cat)}
                  onChange={() => toggle(cat)}
                  className="shrink-0"
                />
                <span className="min-w-0 break-words">{cat}</span>
                <span className="ml-auto text-xs text-[var(--color-text-muted)] shrink-0">
                  {data?.rowTotals[cat] ?? 0}
                </span>
              </label>
            ))}
          </div>
        </Popover>
        {selected.size > 0 && (
          <span className="text-xs text-[var(--color-text-muted)]">
            строки могут не суммироваться в 100 % — остальное ушло в скрытые категории
          </span>
        )}
      </div>

      {error ? (
        <div className="p-10 text-center text-sm text-[var(--color-error,#d33)]">{String(error)}</div>
      ) : isLoading ? (
        <div className="p-6 space-y-3">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-8 bg-[var(--color-border)] rounded animate-pulse" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="p-10 text-center text-sm text-[var(--color-text-muted)]">Нет переходов за выбранный период</div>
      ) : (
        <div className="scroll-x flex-1 px-3 sm:px-6 py-3">
          <table className="border-collapse text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-[var(--color-bg)] text-left p-2 font-medium text-[var(--color-text-muted)] border-b border-[var(--color-border)] min-w-[160px] max-w-[220px]">
                  Купили ↓ / купят →
                </th>
                {shown.map(to => (
                  <th key={to} className="p-1 font-medium text-[var(--color-text-muted)] border-b border-[var(--color-border)] align-bottom">
                    {/* Вертикальные подписи: 50 колонок с горизонтальными именами не
                        влезут ни в какой экран; повёрнутый текст держит колонку ~28px */}
                    <div className="[writing-mode:vertical-rl] rotate-180 max-h-40 overflow-hidden text-ellipsis whitespace-nowrap mx-auto" title={to}>
                      {to}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(from => {
                const total = data?.rowTotals[from] ?? 0;
                return (
                  <tr key={from}>
                    <th className="sticky left-0 z-10 bg-[var(--color-bg)] text-left p-2 font-normal text-[var(--color-text)] border-b border-[var(--color-border)] min-w-[160px] max-w-[220px]">
                      <span className="break-words">{from}</span>
                      <span className="block text-[10px] text-[var(--color-text-muted)]">{total} перех.</span>
                    </th>
                    {shown.map(to => {
                      const n = cellMap.get(`${from}→${to}`) ?? 0;
                      const pct = total > 0 ? (n / total) * 100 : 0;
                      return (
                        <td
                          key={to}
                          title={`${from} → ${to}: ${n} из ${total}`}
                          className={`p-1 text-center border-b border-[var(--color-border)] tabular-nums ${from === to ? 'font-medium' : ''}`}
                          style={{ background: n > 0 ? heatBg(pct) : undefined }}
                        >
                          {n > 0 ? `${pct.toFixed(pct >= 10 ? 0 : 1)}%` : <span className="text-[var(--color-text-muted)]">·</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
