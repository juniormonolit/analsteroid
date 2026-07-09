'use client';
import { useRef, useState } from 'react';
import { RefreshCw, Bookmark, Copy, Check, Scale, SlidersHorizontal } from 'lucide-react';
import type { DealScope, ClientType, ProductGroupMode, ComparisonDisplay, AccountType } from '@/lib/metrics/types';
import { type ViewPrefs } from './ViewSettings';
import { countActiveFilters } from './FiltersMenu';
import { ReportSettingsPanel } from './ReportSettingsPanel';

interface Props {
  dealScope: DealScope;
  clientType: ClientType;
  comparisonDisplay: ComparisonDisplay;
  hasMixedDisplay?: boolean;
  isLoading: boolean;
  showProductGroupPicker?: boolean;
  productGroupMode?: ProductGroupMode;
  onDealScopeChange: (v: DealScope) => void;
  onClientTypeChange: (v: ClientType) => void;
  onComparisonDisplayChange: (v: ComparisonDisplay) => void;
  onProductGroupModeChange?: (v: ProductGroupMode) => void;
  onRefresh: () => void;
  onSaveReport: () => void;
  // Копирование таблицы в буфер (чистый TSV для Google Таблиц)
  onCopyTable?: () => Promise<void>;
  viewPrefs: ViewPrefs;
  onViewPrefsChange: (p: ViewPrefs) => void;
  numberAlign?: 'left' | 'center' | 'right';
  onNumberAlignChange?: (a: 'left' | 'center' | 'right') => void;
  accountType?: AccountType;
  onAccountTypeChange?: (a: AccountType) => void;
  drilldownGrouped?: boolean;
  onDrilldownGroupedChange?: (v: boolean) => void;
  colorizeMetrics?: boolean;
  onColorizeMetricsChange?: (v: boolean) => void;
  // «Зебра» (правка владельца 09.07): лёгкая полосатость чётных строк ReportTable,
  // живёт в объединённой панели «Настройки отчёта» → «Вид».
  zebra?: boolean;
  onZebraChange?: (v: boolean) => void;
  // «Обычная» (п.3а спеки): скрыть попап «Фильтры», «Вид» и кнопку «Сохранить» —
  // остаются только «Копировать» и «Обновить».
  basic?: boolean;
  // Режим «Сравнение» (п. Н2 спеки): открыть правый слайдер со сравнением сущностей
  // отчёта. Про-функция — скрыта в «Обычной» (basic), видна только в «Про» (уточнение
  // Серёги после смока 07.07: по умолчанию решили показывать всегда, но это pro-контрол).
  onOpenComparison?: () => void;
  comparisonCount?: number;
}

export function ReportToolbar({
  dealScope, clientType, comparisonDisplay, hasMixedDisplay,
  isLoading,
  showProductGroupPicker, productGroupMode,
  onDealScopeChange, onClientTypeChange, onComparisonDisplayChange,
  onProductGroupModeChange, onRefresh, onSaveReport, onCopyTable,
  viewPrefs, onViewPrefsChange,
  numberAlign, onNumberAlignChange,
  accountType, onAccountTypeChange,
  drilldownGrouped, onDrilldownGroupedChange,
  colorizeMetrics, onColorizeMetricsChange,
  zebra, onZebraChange,
  basic = false,
  onOpenComparison, comparisonCount = 0,
}: Props) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  async function handleCopy() {
    if (!onCopyTable) return;
    await onCopyTable();
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  }

  // Объединённая панель «Настройки отчёта» (правка 09.07) — раньше здесь были две
  // отдельные кнопки-дропдауна («Фильтры» + «Вид»), см. FiltersMenu/ViewSettings.
  const [showSettings, setShowSettings] = useState(false);
  const activeFiltersCount = countActiveFilters({
    dealScope, onDealScopeChange, clientType, onClientTypeChange,
    productGroupMode, onProductGroupModeChange, showProductGroupPicker,
  });

  return (
    <div className="flex items-center gap-2 px-6 py-2 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex-wrap">
      {!basic && (
        <button
          onClick={() => setShowSettings(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          <SlidersHorizontal size={12} />
          Настройки отчёта
          {activeFiltersCount > 0 && (
            <span className="ml-1 px-1.5 py-0.5 bg-[var(--color-accent)] text-white rounded-full text-[10px]">{activeFiltersCount}</span>
          )}
        </button>
      )}

      {!basic && showSettings && (
        <ReportSettingsPanel
          dealScope={dealScope}
          onDealScopeChange={onDealScopeChange}
          clientType={clientType}
          onClientTypeChange={onClientTypeChange}
          productGroupMode={productGroupMode}
          onProductGroupModeChange={onProductGroupModeChange}
          showProductGroupPicker={showProductGroupPicker}
          prefs={viewPrefs}
          onChange={onViewPrefsChange}
          numberAlign={numberAlign}
          onNumberAlignChange={onNumberAlignChange}
          comparisonDisplay={comparisonDisplay}
          hasMixedDisplay={hasMixedDisplay}
          onComparisonDisplayChange={onComparisonDisplayChange}
          accountType={accountType}
          onAccountTypeChange={onAccountTypeChange}
          drilldownGrouped={drilldownGrouped}
          onDrilldownGroupedChange={onDrilldownGroupedChange}
          colorizeMetrics={colorizeMetrics}
          onColorizeMetricsChange={onColorizeMetricsChange}
          zebra={zebra}
          onZebraChange={onZebraChange}
          onClose={() => setShowSettings(false)}
        />
      )}

      {!basic && onOpenComparison && (
        <button
          onClick={onOpenComparison}
          title="Сравнить сущности отчёта по текущим метрикам (как сравнение товаров в интернет-магазине)"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          <Scale size={12} />
          Сравнение
          {comparisonCount > 0 && (
            <span className="px-1.5 py-0.5 bg-[var(--color-accent)] text-white rounded-full text-[10px] leading-none">{comparisonCount}</span>
          )}
        </button>
      )}

      {/* Правая группа (правка 09.07): «Сохранить»/«Копировать» переехали вплотную
          к «Обновить» — весь блок прижат вправо через ml-auto на обёртке. */}
      <div className="ml-auto flex items-center gap-2">
        {!basic && (
          <button
            onClick={onSaveReport}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            <Bookmark size={12} />
            Сохранить
          </button>
        )}

        {onCopyTable && (
          <button
            onClick={handleCopy}
            title="Скопировать таблицу для вставки в Google Таблицы (числа без ₽, % и пробелов)"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            {copied ? <Check size={12} className="text-[var(--color-positive)]" /> : <Copy size={12} />}
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        )}

        <button
          onClick={onRefresh}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-60"
        >
          <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
          Обновить
        </button>
      </div>
    </div>
  );
}
