'use client';
import { RefreshCw, Bookmark } from 'lucide-react';
import type { DealScope, ClientType, ProductGroupMode, ComparisonDisplay, AccountType } from '@/lib/metrics/types';
import { ViewSettings, type ViewPrefs } from './ViewSettings';
import { FiltersMenu } from './FiltersMenu';

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
  viewPrefs: ViewPrefs;
  onViewPrefsChange: (p: ViewPrefs) => void;
  themeAccent?: string | null;
  onThemeAccentChange?: (c: string | null) => void;
  numberAlign?: 'left' | 'center' | 'right';
  onNumberAlignChange?: (a: 'left' | 'center' | 'right') => void;
  accountType?: AccountType;
  onAccountTypeChange?: (a: AccountType) => void;
  drilldownGrouped?: boolean;
  onDrilldownGroupedChange?: (v: boolean) => void;
}

export function ReportToolbar({
  dealScope, clientType, comparisonDisplay, hasMixedDisplay,
  isLoading,
  showProductGroupPicker, productGroupMode,
  onDealScopeChange, onClientTypeChange, onComparisonDisplayChange,
  onProductGroupModeChange, onRefresh, onSaveReport,
  viewPrefs, onViewPrefsChange,
  themeAccent, onThemeAccentChange,
  numberAlign, onNumberAlignChange,
  accountType, onAccountTypeChange,
  drilldownGrouped, onDrilldownGroupedChange,
}: Props) {
  return (
    <div className="flex items-center gap-2 px-6 py-2 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex-wrap">
      <FiltersMenu
        dealScope={dealScope}
        onDealScopeChange={onDealScopeChange}
        clientType={clientType}
        onClientTypeChange={onClientTypeChange}
        productGroupMode={productGroupMode}
        onProductGroupModeChange={onProductGroupModeChange}
        showProductGroupPicker={showProductGroupPicker}
      />

      <ViewSettings
        prefs={viewPrefs}
        onChange={onViewPrefsChange}
        themeAccent={themeAccent}
        onThemeAccentChange={onThemeAccentChange}
        numberAlign={numberAlign}
        onNumberAlignChange={onNumberAlignChange}
        comparisonDisplay={comparisonDisplay}
        hasMixedDisplay={hasMixedDisplay}
        onComparisonDisplayChange={onComparisonDisplayChange}
        accountType={accountType}
        onAccountTypeChange={onAccountTypeChange}
        drilldownGrouped={drilldownGrouped}
        onDrilldownGroupedChange={onDrilldownGroupedChange}
      />

      <button
        onClick={onSaveReport}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <Bookmark size={12} />
        Сохранить
      </button>

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
