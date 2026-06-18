'use client';
import { useState } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { formatValue, formatDelta, formatDeltaPct } from '@/lib/format';
import type { Metric } from '@/lib/metrics/types';

interface RowDeltas {
  dimensionId: string;
  dimensionName: string;
  teamName: string | null;
  deltas: Record<string, {
    current: number | null;
    comparison: number | null;
    delta: number | null;
    deltaPct: number | null;
  }>;
}

interface Props {
  rows: RowDeltas[];
  totals: Record<string, number | null> | null;
  metrics: Metric[];
  comparisonDisplay: 'full' | 'current';
  isLoading: boolean;
  onRowClick?: (dimensionId: string, dimensionName: string) => void;
}

export function ReportTable({ rows, totals, metrics, comparisonDisplay, isLoading, onRowClick }: Props) {
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  function handleSort(metricId: string) {
    if (sortBy === metricId) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(metricId); setSortDir('desc'); }
  }

  const sorted = [...rows].sort((a, b) => {
    if (!sortBy) return 0;
    const av = a.deltas[sortBy]?.current ?? -Infinity;
    const bv = b.deltas[sortBy]?.current ?? -Infinity;
    return sortDir === 'desc' ? bv - av : av - bv;
  });

  const colSpan = comparisonDisplay === 'full' ? 4 : 1;

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-8 bg-[var(--color-border)] rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="p-6 text-center text-[var(--color-text-muted)] text-sm">
        Нет данных за выбранный период
      </div>
    );
  }

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-sm border-collapse">
        <thead className="sticky top-0 z-10 bg-[var(--color-table-header)]">
          <tr>
            <th className="sticky left-0 z-20 bg-[var(--color-table-header)] text-left px-4 py-2.5 font-medium text-[var(--color-text)] border-b border-r border-[var(--color-border)] min-w-[180px]">
              Менеджер
            </th>
            {metrics.map(m => (
              <th
                key={m.id}
                colSpan={colSpan}
                className="text-center px-2 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] whitespace-nowrap"
              >
                <button
                  onClick={() => handleSort(m.id)}
                  className="flex items-center gap-1 mx-auto hover:text-[var(--color-accent)] transition-colors"
                >
                  {m.nameShortRu ?? m.nameRu}
                  {sortBy === m.id && (sortDir === 'desc' ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                </button>
              </th>
            ))}
          </tr>
          {comparisonDisplay === 'full' && (
            <tr className="bg-[var(--color-table-header)]">
              <th className="sticky left-0 z-20 bg-[var(--color-table-header)] border-b border-r border-[var(--color-border)]" />
              {metrics.map(m => (
                <>
                  <th key={`${m.id}-cur`} className="text-right px-2 py-1 text-xs font-normal text-[var(--color-text-muted)] border-b border-[var(--color-border)] border-l whitespace-nowrap">Текущий</th>
                  <th key={`${m.id}-cmp`} className="text-right px-2 py-1 text-xs font-normal text-[var(--color-text-muted)] border-b border-[var(--color-border)] whitespace-nowrap">Сравнение</th>
                  <th key={`${m.id}-d`} className="text-right px-2 py-1 text-xs font-normal text-[var(--color-text-muted)] border-b border-[var(--color-border)] whitespace-nowrap">Δ</th>
                  <th key={`${m.id}-dp`} className="text-right px-2 py-1 text-xs font-normal text-[var(--color-text-muted)] border-b border-[var(--color-border)] whitespace-nowrap">Δ%</th>
                </>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr
              key={row.dimensionId}
              className={`border-b border-[var(--color-border)] hover:bg-[var(--color-table-row-hover)] ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''} ${onRowClick ? 'cursor-pointer' : ''}`}
              onClick={onRowClick ? () => onRowClick(row.dimensionId, row.dimensionName) : undefined}
            >
              <td className="sticky left-0 bg-inherit px-4 py-2 font-medium border-r border-[var(--color-border)] whitespace-nowrap">
                {onRowClick ? (
                  <span className="hover:text-[var(--color-accent)] hover:underline transition-colors">{row.dimensionName}</span>
                ) : row.dimensionName}
                {row.teamName && (
                  <span className="block text-xs text-[var(--color-text-muted)] font-normal">{row.teamName}</span>
                )}
              </td>
              {metrics.map(m => {
                const d = row.deltas?.[m.id];
                return comparisonDisplay === 'full' ? (
                  <>
                    <td key={`${m.id}-cur`} className="text-right px-2 py-2 border-l border-[var(--color-border)] tabular-nums whitespace-nowrap">
                      {formatValue(d?.current ?? null, m.dataType, m.decimalPlaces)}
                    </td>
                    <td key={`${m.id}-cmp`} className="text-right px-2 py-2 tabular-nums text-[var(--color-text-muted)] whitespace-nowrap">
                      {formatValue(d?.comparison ?? null, m.dataType, m.decimalPlaces)}
                    </td>
                    <td key={`${m.id}-d`} className={`text-right px-2 py-2 tabular-nums whitespace-nowrap ${(d?.delta ?? 0) > 0 ? 'text-[var(--color-positive)]' : (d?.delta ?? 0) < 0 ? 'text-[var(--color-negative)]' : ''}`}>
                      {formatDelta(d?.delta ?? null, m.dataType, m.decimalPlaces)}
                    </td>
                    <td key={`${m.id}-dp`} className={`text-right px-2 py-2 tabular-nums whitespace-nowrap ${(d?.deltaPct ?? 0) > 0 ? 'text-[var(--color-positive)]' : (d?.deltaPct ?? 0) < 0 ? 'text-[var(--color-negative)]' : ''}`}>
                      {formatDeltaPct(d?.deltaPct ?? null)}
                    </td>
                  </>
                ) : (
                  <td key={`${m.id}-cur`} className="text-right px-3 py-2 border-l border-[var(--color-border)] tabular-nums whitespace-nowrap">
                    {formatValue(d?.current ?? null, m.dataType, m.decimalPlaces)}
                  </td>
                );
              })}
            </tr>
          ))}

          {/* Totals row */}
          {totals && (
            <tr className="border-t-2 border-[var(--color-border)] bg-[var(--color-table-header)] font-medium sticky bottom-0">
              <td className="sticky left-0 bg-[var(--color-table-header)] px-4 py-2 border-r border-[var(--color-border)]">
                Итого
              </td>
              {metrics.map(m => (
                comparisonDisplay === 'full' ? (
                  <>
                    <td key={`tot-${m.id}-cur`} className="text-right px-2 py-2 border-l border-[var(--color-border)] tabular-nums">
                      {formatValue(totals[m.id] ?? null, m.dataType, m.decimalPlaces)}
                    </td>
                    <td key={`tot-${m.id}-cmp`} className="text-right px-2 py-2 tabular-nums text-[var(--color-text-muted)]">—</td>
                    <td key={`tot-${m.id}-d`} className="text-right px-2 py-2 tabular-nums">—</td>
                    <td key={`tot-${m.id}-dp`} className="text-right px-2 py-2 tabular-nums">—</td>
                  </>
                ) : (
                  <td key={`tot-${m.id}-cur`} className="text-right px-3 py-2 border-l border-[var(--color-border)] tabular-nums">
                    {formatValue(totals[m.id] ?? null, m.dataType, m.decimalPlaces)}
                  </td>
                )
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
