'use client';
import { useState } from 'react';
import { RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { DealScope, Grouping, Metric, ProductGroupMode } from '@/lib/metrics/types';

interface Props {
  dealScope: DealScope;
  grouping: Grouping;
  comparisonDisplay: 'full' | 'current';
  metricIds: string[];
  availableMetrics: Metric[];
  isLoading: boolean;
  showProductGroupPicker?: boolean;
  productGroupMode?: ProductGroupMode;
  onDealScopeChange: (v: DealScope) => void;
  onGroupingChange: (v: Grouping) => void;
  onComparisonDisplayChange: (v: 'full' | 'current') => void;
  onMetricIdsChange: (ids: string[]) => void;
  onProductGroupModeChange?: (v: ProductGroupMode) => void;
  onRefresh: () => void;
}

function Seg<T extends string>({
  options, value, onChange, labels,
}: { options: T[]; value: T; onChange: (v: T) => void; labels: Record<T, string> }) {
  return (
    <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
      {options.map(opt => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`px-3 py-1.5 transition-colors ${
            value === opt
              ? 'bg-[var(--color-accent)] text-white'
              : 'bg-[var(--color-bg-surface)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
          }`}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  );
}

export function ReportToolbar({
  dealScope, grouping, comparisonDisplay, metricIds,
  availableMetrics, isLoading,
  showProductGroupPicker, productGroupMode,
  onDealScopeChange, onGroupingChange, onComparisonDisplayChange,
  onMetricIdsChange, onProductGroupModeChange, onRefresh,
}: Props) {
  const [showMetrics, setShowMetrics] = useState(false);

  const allIds = availableMetrics.map(m => m.id);
  const selectedSet = new Set(metricIds.includes('all_core') ? allIds : metricIds);

  function toggleMetric(id: string) {
    const next = new Set(selectedSet);
    if (next.has(id)) {
      if (next.size > 1) next.delete(id);
    } else {
      next.add(id);
    }
    if (next.size === allIds.length) onMetricIdsChange(['all_core']);
    else onMetricIdsChange(Array.from(next));
  }

  return (
    <div className="flex items-center gap-3 px-6 py-2 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex-wrap">
      <Seg
        options={['primary', 'repeat', 'all'] as DealScope[]}
        value={dealScope}
        onChange={onDealScopeChange}
        labels={{ primary: 'Первичные', repeat: 'Повторные', all: 'Все' }}
      />

      <Seg
        options={['none', 'team', 'total'] as Grouping[]}
        value={grouping}
        onChange={onGroupingChange}
        labels={{ none: 'Без группировки', team: 'По отделу', total: 'Итого' }}
      />

      <Seg
        options={['full', 'current'] as const}
        value={comparisonDisplay}
        onChange={onComparisonDisplayChange}
        labels={{ full: 'Сравнение', current: 'Только текущий' }}
      />

      {showProductGroupPicker && productGroupMode && onProductGroupModeChange && (
        <Seg
          options={['kc', 'by_max'] as ProductGroupMode[]}
          value={productGroupMode}
          onChange={onProductGroupModeChange}
          labels={{ kc: 'Категория КЦ', by_max: 'По наибольшему' }}
        />
      )}

      {/* Metric picker */}
      {availableMetrics.length > 0 && (
        <div className="relative">
          <button
            onClick={() => setShowMetrics(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            <SlidersHorizontal size={12} />
            Метрики
            {!metricIds.includes('all_core') && (
              <span className="ml-1 px-1.5 py-0.5 bg-[var(--color-accent)] text-white rounded-full text-[10px]">
                {metricIds.length}
              </span>
            )}
          </button>

          {showMetrics && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowMetrics(false)} />
              <div className="absolute top-full left-0 mt-1 z-20 bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-lg min-w-[220px] max-h-[340px] overflow-y-auto">
                <div className="flex gap-3 px-3 py-2 border-b border-[var(--color-border)]">
                  <button
                    onClick={() => { onMetricIdsChange(['all_core']); setShowMetrics(false); }}
                    className="text-xs text-[var(--color-accent)] hover:underline"
                  >
                    Все
                  </button>
                  <span className="text-[var(--color-border)]">·</span>
                  <button
                    onClick={() => availableMetrics.length > 0 && onMetricIdsChange([availableMetrics[0].id])}
                    className="text-xs text-[var(--color-text-muted)] hover:underline"
                  >
                    Сбросить
                  </button>
                </div>
                {availableMetrics.map(m => (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-bg-hover)] cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSet.has(m.id)}
                      onChange={() => toggleMetric(m.id)}
                      className="accent-[var(--color-accent)]"
                    />
                    <span className="text-sm text-[var(--color-text)]">{m.nameShortRu ?? m.nameRu}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <button
        onClick={onRefresh}
        disabled={isLoading}
        className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-60"
      >
        <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
        Обновить
      </button>
    </div>
  );
}
