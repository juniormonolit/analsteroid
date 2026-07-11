'use client';
import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { SlideBackdrop } from '@/components/ui/SlideBackdrop';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import {
  MainPeriodControl, ComparisonPeriodControl, DepartmentPicker,
  MetricsButton, SearchField, GroupingSelector, SourceDimensionSelector,
  type FilterBarProps,
} from './FilterBar';
import {
  SettingsPanelButton, ComparisonTriggerButton, SaveButton, RefreshButton,
  type ReportToolbarProps,
} from './ReportToolbar';
import { ExportMenu } from './ExportMenu';
import { countActiveFilters } from './FiltersMenu';

interface Props extends FilterBarProps, ReportToolbarProps {}

/**
 * Мобильный тулбар отчёта (<768px, задача 1714) — владелец (Серёга) прислал скрин с
 * телефона: управление отчётом занимало ~75% высоты экрана, самой таблице оставалось
 * 2 строки. Снаружи над таблицей остаётся ТОЛЬКО компактный пикер основного периода
 * (MainPeriodControl с compact) и одна кнопка «Фильтры» с общим бейджем — весь
 * остальной набор контролов (было — две строки: FilterBar + ReportToolbar) переезжает
 * в выдвижную панель по тому же паттерну, что уже используют все панели приложения
 * («Настройки отчёта», карточка менеджера, сравнение, дрилл-даун, ченджлог): SlideBackdrop
 * (z-40) + панель `fixed inset-y-0 right-0` (z-50) со slide-in/out анимацией и
 * useSlideClose. На ширинах ≥768px эта панель — во всю ширину экрана (`w-full`, без
 * `sm:w-[...]` — панель существует ТОЛЬКО в мобильной ветке рендера, десктоп её вообще
 * не монтирует, см. условие isMobile в SalesReportPage.tsx). Bottom-sheet не
 * использован: этого паттерна нет ни в одном другом компоненте приложения (ai_docs/
 * DESIGN_GUIDELINES.md и все ~10 существующих слайд-панелей — только «справа, полная
 * ширина на мобиле»), а правило lint:responsive запрещает придумывать новый
 * поповер/панельный движок — переиспользуем то, что уже есть.
 *
 * ВСЕ элементы внутри — те же переиспользуемые куски FilterBar.tsx/ReportToolbar.tsx
 * (MainPeriodControl, ComparisonPeriodControl, DepartmentPicker, MetricsButton,
 * SearchField, GroupingSelector/SourceDimensionSelector, SettingsPanelButton,
 * ComparisonTriggerButton, SaveButton, RefreshButton, ExportMenu) — никакой второй
 * копии состояния/логики: все они управляются теми же пропсами/колбэками, что и
 * прежде получал FilterBar+ReportToolbar на десктопе, стейт по-прежнему целиком в
 * SalesReportPage.tsx. Панели верхнего уровня (ReportSettingsPanel — внутри
 * SettingsPanelButton, ComparisonPanel/MetricPanel/SaveReportModal — рендерятся в
 * SalesReportPage.tsx поверх этой панели, z-index уже решён тем же способом, что и
 * для остальных вложенных панелей приложения (см. components/ui/Popover.tsx).
 */
export function MobileReportBar(props: Props) {
  const {
    period, comparison, departmentIds, search = '', grouping,
    onPeriodChange, onComparisonChange, onDepartmentIdsChange, onSearchChange, onGroupingChange,
    onOpenMetricPanel, metricsBadge, showDepartments = true, sourceDimension, onSourceDimensionChange,
    dealScope, onDealScopeChange, clientType, onClientTypeChange,
    productGroupMode, onProductGroupModeChange, showProductGroupPicker,
    comparisonDisplay, onComparisonDisplayChange, hasMixedDisplay,
    numberAlign, onNumberAlignChange, accountType, onAccountTypeChange,
    drilldownGrouped, onDrilldownGroupedChange, colorizeMetrics, onColorizeMetricsChange,
    zebra, onZebraChange, borderMode, onBorderModeChange,
    createdTimeFilter, onCreatedTimeFilterChange, firstTouchFilter, onFirstTouchFilterChange,
    viewPrefs, onViewPrefsChange,
    basic = false, forceShowSave = false,
    onSaveReport, onCopyTable, onExportExcel, onExportPdf, onExportPng,
    onRefresh, isLoading,
    onOpenComparison, comparisonCount = 0,
  } = props;

  const [open, setOpen] = useState(false);
  const { closing, requestClose } = useSlideClose(() => setOpen(false));

  // Бейдж «Фильтры · N» (п.1 задачи 1714): активные фильтры + поиск + сравнение вкл +
  // группировка не-дефолтная — та же countActiveFilters, что и у десктопной «Настройки
  // отчёта», расширенная тремя опциональными полями (см. FiltersMenu.tsx).
  const badgeCount = countActiveFilters({
    dealScope, onDealScopeChange, clientType, onClientTypeChange,
    productGroupMode, onProductGroupModeChange, showProductGroupPicker,
    createdTimeFilter, onCreatedTimeFilterChange, firstTouchFilter, onFirstTouchFilterChange,
    search, grouping, comparisonDisplay,
  });

  const settingsProps = {
    dealScope, onDealScopeChange, clientType, onClientTypeChange,
    productGroupMode, onProductGroupModeChange, showProductGroupPicker,
    prefs: viewPrefs, onChange: onViewPrefsChange,
    numberAlign, onNumberAlignChange,
    comparisonDisplay, hasMixedDisplay, onComparisonDisplayChange,
    accountType, onAccountTypeChange,
    drilldownGrouped, onDrilldownGroupedChange,
    colorizeMetrics, onColorizeMetricsChange,
    zebra, onZebraChange,
    borderMode, onBorderModeChange,
    createdTimeFilter, onCreatedTimeFilterChange, firstTouchFilter, onFirstTouchFilterChange,
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)]">
      <MainPeriodControl
        period={period}
        onPeriodChange={onPeriodChange}
        onComparisonChange={onComparisonChange}
        compact
      />

      <button
        onClick={() => setOpen(true)}
        data-testid="mobile-filters-trigger"
        className="tap-target ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <SlidersHorizontal size={13} />
        Фильтры
        {badgeCount > 0 && (
          <span className="ml-0.5 px-1.5 py-0.5 bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-full text-[10px]">{badgeCount}</span>
        )}
      </button>

      {open && (
        <>
          <SlideBackdrop closing={closing} onClick={requestClose} />
          <div
            className={`fixed inset-y-0 right-0 z-50 bg-[var(--color-bg-surface)] shadow-2xl flex flex-col w-full ${
              closing ? 'slide-panel-out-right' : 'slide-panel-in-right'
            }`}
          >
            <PanelCloseTab onClick={requestClose} />

            <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-[var(--color-border)] flex-shrink-0">
              <div className="font-semibold text-[var(--color-text)] text-base">Фильтры</div>
              <button onClick={requestClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors ml-2">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4" data-testid="mobile-filters-body">
              <div className="flex flex-wrap items-center gap-2">
                <ComparisonPeriodControl comparison={comparison} onComparisonChange={onComparisonChange} />
                {showDepartments && (
                  <DepartmentPicker departmentIds={departmentIds} onDepartmentIdsChange={onDepartmentIdsChange} />
                )}
                {onOpenMetricPanel && (
                  <MetricsButton onOpenMetricPanel={onOpenMetricPanel} metricsBadge={metricsBadge} />
                )}
              </div>

              {onSearchChange && (
                <SearchField search={search} onSearchChange={onSearchChange} widthClassName="w-full" />
              )}

              {onSourceDimensionChange && sourceDimension !== undefined ? (
                <SourceDimensionSelector sourceDimension={sourceDimension} onSourceDimensionChange={onSourceDimensionChange} stacked />
              ) : onGroupingChange && grouping !== undefined ? (
                <GroupingSelector grouping={grouping} onGroupingChange={onGroupingChange} stacked />
              ) : null}

              <div className="border-t border-[var(--color-border)] pt-4 flex flex-col gap-2.5 [&>button]:w-full [&>button]:justify-center [&>button]:py-2">
                {!basic && <SettingsPanelButton {...settingsProps} />}
                {!basic && onOpenComparison && (
                  <ComparisonTriggerButton onOpenComparison={onOpenComparison} comparisonCount={comparisonCount} />
                )}
                {(!basic || forceShowSave) && <SaveButton onSaveReport={onSaveReport} />}
                {onCopyTable && onExportExcel && onExportPdf && onExportPng && (
                  <ExportMenu
                    onCopyTable={onCopyTable}
                    onExportExcel={onExportExcel}
                    onExportPdf={onExportPdf}
                    onExportPng={onExportPng}
                    disabled={isLoading}
                  />
                )}
                <RefreshButton onRefresh={onRefresh} isLoading={isLoading} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
