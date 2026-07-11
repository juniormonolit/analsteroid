'use client';
import { useState } from 'react';
import { RefreshCw, Bookmark, Scale, SlidersHorizontal } from 'lucide-react';
import type { DealScope, ClientType, ProductGroupMode, ComparisonDisplay, AccountType, BorderMode, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';
import { type ViewPrefs } from './ViewSettings';
import { type FiltersFieldsProps, countActiveFilters } from './FiltersMenu';
import { type ViewSettingsFieldsProps } from './ViewSettings';
import { ReportSettingsPanel } from './ReportSettingsPanel';
import { ExportMenu } from './ExportMenu';

// Экспортируется как ReportToolbarProps (задача 1714, мобильный тулбар) — MobileReportBar
// компонует те же поля через переиспользуемые куски (SettingsPanelButton,
// ComparisonTriggerButton, SaveButton, RefreshButton, ExportMenu) в выдвижной панели,
// без второй копии состояния/типов.
export interface ReportToolbarProps {
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
  // «Скачать» (задача 1706, заменил одиночную «Копировать»): дропдаун из 4 пунктов —
  // копирование в буфер (TSV) + скачивание Excel/PDF/PNG. Опционален как и раньше
  // onCopyTable — если родитель не передал ни одного обработчика, кнопка не рендерится.
  onCopyTable?: () => Promise<void>;
  onExportExcel?: () => Promise<void>;
  onExportPdf?: () => Promise<void>;
  onExportPng?: () => Promise<void>;
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
  // «Границы» (п.4 правок 09.07): grid/horizontal/none — живёт в той же панели «Вид».
  borderMode?: BorderMode;
  onBorderModeChange?: (v: BorderMode) => void;
  // «Обычная» (п.3а спеки): скрыть попап «Фильтры», «Вид» и кнопку «Сохранить» —
  // остаются только «Копировать» и «Обновить».
  basic?: boolean;
  // Точечное исключение из Лайт-гейта на «Сохранить» (задача 1572, п.5): отчёт,
  // открытый через «Создать отчёт», должен уметь сохраниться и в Лайте — иначе
  // фича там бессмысленна (построил и потерял). Остальные basic-ограничения
  // (панель настроек, «Сравнение») это НЕ снимает — только саму кнопку «Сохранить».
  forceShowSave?: boolean;
  // Режим «Сравнение» (п. Н2 спеки): открыть правый слайдер со сравнением сущностей
  // отчёта. Про-функция — скрыта в «Обычной» (basic), видна только в «Про» (уточнение
  // Серёги после смока 07.07: по умолчанию решили показывать всегда, но это pro-контрол).
  onOpenComparison?: () => void;
  comparisonCount?: number;
  // Задача 1569: экспериментальные фильтры по нерабочему времени — сессионные, не
  // персистятся в SavedReport (см. FiltersMenu.tsx). Опциональны, как accountType.
  createdTimeFilter?: CreatedTimeFilter;
  onCreatedTimeFilterChange?: (v: CreatedTimeFilter) => void;
  firstTouchFilter?: FirstTouchFilter;
  onFirstTouchFilterChange?: (v: FirstTouchFilter) => void;
}
type Props = ReportToolbarProps;

// ── «Настройки отчёта» — кнопка + бейдж + сама панель (ReportSettingsPanel), вынесены
// отдельным компонентом (задача 1714): используются и в десктопной строке ReportToolbar,
// и внутри мобильной панели «Фильтры» (MobileReportBar) — то же локальное состояние
// открытия/закрытия, та же панель, без второй копии. Видимость по Лайт-режиму (`basic`)
// остаётся на вызывающей стороне (`{!basic && <SettingsPanelButton .../>}`), как и раньше.
export function SettingsPanelButton(props: FiltersFieldsProps & ViewSettingsFieldsProps) {
  const [showSettings, setShowSettings] = useState(false);
  const activeFiltersCount = countActiveFilters(props);

  return (
    <>
      <button
        onClick={() => setShowSettings(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <SlidersHorizontal size={12} />
        Настройки отчёта
        {activeFiltersCount > 0 && (
          <span className="ml-1 px-1.5 py-0.5 bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-full text-[10px]">{activeFiltersCount}</span>
        )}
      </button>
      {showSettings && (
        <ReportSettingsPanel {...props} onClose={() => setShowSettings(false)} />
      )}
    </>
  );
}

// ── «Сравнение» — кнопка-триггер, вынесена отдельным компонентом (задача 1714) для
// переиспользования в мобильной панели. Сама панель (ComparisonPanel) остаётся на
// уровне SalesReportPage (её open-состояние там же) — тут только кнопка с бейджем.
export function ComparisonTriggerButton({ onOpenComparison, comparisonCount = 0 }: {
  onOpenComparison: () => void; comparisonCount?: number;
}) {
  return (
    <button
      onClick={onOpenComparison}
      title="Сравнить сущности отчёта по текущим метрикам (как сравнение товаров в интернет-магазине)"
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
    >
      <Scale size={12} />
      Сравнение
      {comparisonCount > 0 && (
        <span className="px-1.5 py-0.5 bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-full text-[10px] leading-none">{comparisonCount}</span>
      )}
    </button>
  );
}

// ── «Сохранить» — вынесена отдельным компонентом (задача 1714) для переиспользования
// в мобильной панели. Панель (SaveReportModal) остаётся на уровне SalesReportPage.
export function SaveButton({ onSaveReport }: { onSaveReport: () => void }) {
  return (
    <button
      onClick={onSaveReport}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
    >
      <Bookmark size={12} />
      Сохранить
    </button>
  );
}

// ── «Обновить» — вынесена отдельным компонентом (задача 1714) для переиспользования
// в мобильной панели.
export function RefreshButton({ onRefresh, isLoading }: { onRefresh: () => void; isLoading: boolean }) {
  return (
    <button
      onClick={onRefresh}
      disabled={isLoading}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-60"
    >
      <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
      Обновить
    </button>
  );
}

export function ReportToolbar({
  dealScope, clientType, comparisonDisplay, hasMixedDisplay,
  isLoading,
  showProductGroupPicker, productGroupMode,
  onDealScopeChange, onClientTypeChange, onComparisonDisplayChange,
  onProductGroupModeChange, onRefresh, onSaveReport, onCopyTable, onExportExcel, onExportPdf, onExportPng,
  viewPrefs, onViewPrefsChange,
  numberAlign, onNumberAlignChange,
  accountType, onAccountTypeChange,
  drilldownGrouped, onDrilldownGroupedChange,
  colorizeMetrics, onColorizeMetricsChange,
  zebra, onZebraChange,
  borderMode, onBorderModeChange,
  basic = false,
  forceShowSave = false,
  onOpenComparison, comparisonCount = 0,
  createdTimeFilter, onCreatedTimeFilterChange, firstTouchFilter, onFirstTouchFilterChange,
}: Props) {
  // Объединённая панель «Настройки отчёта» (правка 09.07) — раньше здесь были две
  // отдельные кнопки-дропдауна («Фильтры» + «Вид»), см. FiltersMenu/ViewSettings.
  // Кнопка+панель, «Сравнение», «Сохранить», «Обновить» вынесены компонентами выше
  // (задача 1714) — здесь только композиция в прежней раскладке, вывод не меняется.
  const settingsProps: FiltersFieldsProps & ViewSettingsFieldsProps = {
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
    <div className="flex items-center gap-2 px-6 py-2 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex-wrap">
      {!basic && <SettingsPanelButton {...settingsProps} />}

      {!basic && onOpenComparison && (
        <ComparisonTriggerButton onOpenComparison={onOpenComparison} comparisonCount={comparisonCount} />
      )}

      {/* Правая группа (правка 09.07): «Сохранить»/«Копировать» переехали вплотную
          к «Обновить» — весь блок прижат вправо через ml-auto на обёртке. */}
      <div className="ml-auto flex items-center gap-2">
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
  );
}
