'use client';
import { SlidersHorizontal, RefreshCw, Bookmark } from 'lucide-react';
import type { DealScope, ClientType, Grouping, Metric, ProductGroupMode, ComparisonDisplay } from '@/lib/metrics/types';
import type { MetricHighlightConfig } from '@/lib/saved-reports/types';
import { ViewSettings, type ViewPrefs } from './ViewSettings';

interface Props {
  dealScope: DealScope;
  clientType: ClientType;
  grouping: Grouping;
  comparisonDisplay: ComparisonDisplay;
  hasMixedDisplay?: boolean;
  metricIds: string[];
  availableMetrics: Metric[];
  highlights: Record<string, MetricHighlightConfig>;
  isLoading: boolean;
  showProductGroupPicker?: boolean;
  productGroupMode?: ProductGroupMode;
  onDealScopeChange: (v: DealScope) => void;
  onClientTypeChange: (v: ClientType) => void;
  onGroupingChange: (v: Grouping) => void;
  onComparisonDisplayChange: (v: ComparisonDisplay) => void;
  onMetricIdsChange: (ids: string[]) => void;
  onProductGroupModeChange?: (v: ProductGroupMode) => void;
  onRefresh: () => void;
  onOpenMetricPanel: () => void;
  onSaveReport: () => void;
  viewPrefs: ViewPrefs;
  onViewPrefsChange: (p: ViewPrefs) => void;
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
  dealScope, clientType, grouping, comparisonDisplay, hasMixedDisplay, metricIds,
  availableMetrics, highlights, isLoading,
  showProductGroupPicker, productGroupMode,
  onDealScopeChange, onClientTypeChange, onGroupingChange, onComparisonDisplayChange,
  onMetricIdsChange, onProductGroupModeChange, onRefresh,
  onOpenMetricPanel, onSaveReport,
  viewPrefs, onViewPrefsChange,
}: Props) {
  const nonDefaultCount = metricIds.includes('all_core') ? 0 : metricIds.length;
  const highlightCount = Object.keys(highlights).length;

  // Effective display value for the pill: "mixed" when any metric overrides global
  const displayValue = hasMixedDisplay ? 'mixed' : comparisonDisplay;
  type DisplayOpt = ComparisonDisplay | 'mixed';
  const displayOptions: DisplayOpt[] = hasMixedDisplay
    ? ['full', 'current', 'compact', 'mixed']
    : ['full', 'current', 'compact'];
  const displayLabels: Record<DisplayOpt, string> = {
    full: 'Сравнение',
    current: 'Только текущий',
    compact: 'Компактный',
    mixed: 'Смешанный',
  };

  return (
    <div className="flex items-center gap-3 px-6 py-2 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex-wrap">
      <Seg
        options={['primary', 'repeat', 'all'] as DealScope[]}
        value={dealScope}
        onChange={onDealScopeChange}
        labels={{ primary: 'Первичные', repeat: 'Повторные', all: 'Все' }}
      />
      <Seg
        options={['all', 'b2c', 'b2b'] as ClientType[]}
        value={clientType}
        onChange={onClientTypeChange}
        labels={{ all: 'Все', b2c: 'Физлица', b2b: 'Юрлица' }}
      />
      <Seg
        options={['none', 'team', 'total'] as Grouping[]}
        value={grouping}
        onChange={onGroupingChange}
        labels={{ none: 'Без группировки', team: 'По отделу', total: 'Итого' }}
      />
      <Seg
        options={displayOptions}
        value={displayValue}
        onChange={v => { if (v !== 'mixed') onComparisonDisplayChange(v as ComparisonDisplay); }}
        labels={displayLabels}
      />
      {showProductGroupPicker && productGroupMode && onProductGroupModeChange && (
        <Seg
          options={['kc', 'by_max'] as ProductGroupMode[]}
          value={productGroupMode}
          onChange={onProductGroupModeChange}
          labels={{ kc: 'Категория КЦ', by_max: 'По наибольшему' }}
        />
      )}

      <button
        onClick={onOpenMetricPanel}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <SlidersHorizontal size={12} />
        Метрики
        {(nonDefaultCount > 0 || highlightCount > 0) && (
          <span className="ml-1 px-1.5 py-0.5 bg-[var(--color-accent)] text-white rounded-full text-[10px]">
            {nonDefaultCount > 0 ? nonDefaultCount : highlightCount}
          </span>
        )}
      </button>

      <button
        onClick={onSaveReport}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <Bookmark size={12} />
        Сохранить
      </button>

      <div className="ml-auto">
        <ViewSettings prefs={viewPrefs} onChange={onViewPrefsChange} />
      </div>

      <button
        onClick={onRefresh}
        disabled={isLoading}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-60"
      >
        <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
        Обновить
      </button>
    </div>
  );
}
