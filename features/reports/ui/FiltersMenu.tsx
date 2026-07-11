'use client';
import { Filter } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import type { DealScope, ClientType, ProductGroupMode, AccountType, CreatedTimeFilter, FirstTouchFilter, Grouping, ComparisonDisplay } from '@/lib/metrics/types';

export function Seg<T extends string>({ options, value, onChange, labels }: {
  options: T[]; value: T; onChange: (v: T) => void; labels: Record<T, string>;
}) {
  return (
    <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
      {options.map(o => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`flex-1 px-2 py-1.5 transition-colors whitespace-nowrap ${value === o ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
        >
          {labels[o]}
        </button>
      ))}
    </div>
  );
}

export interface FiltersFieldsProps {
  dealScope: DealScope;
  onDealScopeChange: (v: DealScope) => void;
  clientType: ClientType;
  onClientTypeChange: (v: ClientType) => void;
  productGroupMode?: ProductGroupMode;
  onProductGroupModeChange?: (v: ProductGroupMode) => void;
  showProductGroupPicker?: boolean;
  // Тип аккаунтов — актуален только для отчёта/дрилл-дауна по менеджерам
  // (мини-отчёт с dimensionType='manager'); в основном тулбаре живёт в ViewSettings,
  // здесь — для дрилл-дауна, где это полноценный фильтр сделок.
  accountType?: AccountType;
  onAccountTypeChange?: (v: AccountType) => void;
  // Задача 1569 (владелец, «побаловаться») — экспериментальная сегментация по
  // нерабочему времени: НЕ персистится в SavedReport (сессионное состояние, как
  // metricFilters в SalesReportPage.tsx), поэтому необязательные пропсы без
  // отдельного saved-reports поля. Опциональны и здесь: без хендлеров блок просто
  // не рендерится (тот же паттерн, что accountType/productGroupMode выше).
  createdTimeFilter?: CreatedTimeFilter;
  onCreatedTimeFilterChange?: (v: CreatedTimeFilter) => void;
  firstTouchFilter?: FirstTouchFilter;
  onFirstTouchFilterChange?: (v: FirstTouchFilter) => void;
}

// Кол-во нефолтовых фильтров → бейдж (виден без открытия панели). Дефолты: все сделки,
// все клиенты, «По наибольшему» (by_max), «Менеджеры». Вынесено отдельной функцией
// (правка 09.07, объединение «Фильтры»+«Вид» в «Настройки отчёта»), чтобы кнопка
// объединённой панели в ReportToolbar считала бейдж тем же способом, что и раньше
// FiltersMenu, без дублирования условий.
//
// Задача 1714 (мобильный тулбар): бейдж кнопки «Фильтры» снаружи мобильной панели шире
// прежнего — владелец: «активные фильтры + поиск + сравнение вкл + группировка
// не-дефолтная». Расширяем ЭТУ ЖЕ функцию тремя опциональными полями вместо копии —
// десктопный вызов в ReportToolbar их не передаёт (undefined ⇒ 0), поэтому его бейдж
// не меняется; MobileReportBar передаёт все три.
export function countActiveFilters({
  dealScope, clientType, showProductGroupPicker, productGroupMode, accountType, onAccountTypeChange,
  createdTimeFilter, onCreatedTimeFilterChange, firstTouchFilter, onFirstTouchFilterChange,
  search, grouping, comparisonDisplay,
}: FiltersFieldsProps & { search?: string; grouping?: Grouping; comparisonDisplay?: ComparisonDisplay }): number {
  return (dealScope !== 'all' ? 1 : 0) + (clientType !== 'all' ? 1 : 0)
    + (showProductGroupPicker && productGroupMode && productGroupMode !== 'by_max' ? 1 : 0)
    + (onAccountTypeChange && accountType && accountType !== 'managers' ? 1 : 0)
    + (onCreatedTimeFilterChange && createdTimeFilter && createdTimeFilter !== 'all' ? 1 : 0)
    + (onFirstTouchFilterChange && firstTouchFilter && firstTouchFilter !== 'all' ? 1 : 0)
    + (search && search.trim() ? 1 : 0)
    + (grouping && grouping !== 'none' ? 1 : 0)
    + (comparisonDisplay && comparisonDisplay !== 'current' ? 1 : 0);
}

// Содержимое «Фильтры» — вынесено из-под Popover-обёртки (правка 09.07), чтобы
// использовать И в самостоятельном дропдауне (FiltersMenu ниже, свои независимые
// фильтры дрилл-дауна), И в объединённой панели «Настройки отчёта»
// (ReportSettingsPanel — левая колонка основного тулбара), без дублирования разметки.
export function FiltersFields({
  dealScope, onDealScopeChange, clientType, onClientTypeChange, productGroupMode, onProductGroupModeChange,
  showProductGroupPicker, accountType, onAccountTypeChange,
  createdTimeFilter, onCreatedTimeFilterChange, firstTouchFilter, onFirstTouchFilterChange,
}: FiltersFieldsProps) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">Тип сделок</div>
        <Seg
          options={['primary', 'repeat', 'all'] as DealScope[]}
          value={dealScope}
          onChange={onDealScopeChange}
          labels={{ primary: 'Первичные', repeat: 'Повторные', all: 'Все' }}
        />
      </div>
      <div>
        <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">Тип клиента</div>
        <Seg
          options={['b2c', 'b2b', 'all'] as ClientType[]}
          value={clientType}
          onChange={onClientTypeChange}
          labels={{ b2c: 'Физлица', b2b: 'Юрлица', all: 'Все' }}
        />
      </div>
      {showProductGroupPicker && onProductGroupModeChange && productGroupMode !== undefined && (
        <div>
          <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">Товарные группы</div>
          <Seg
            options={['kc', 'by_max'] as ProductGroupMode[]}
            value={productGroupMode}
            onChange={onProductGroupModeChange}
            labels={{ kc: 'Категория КЦ', by_max: 'По наибольшему' }}
          />
        </div>
      )}
      {onAccountTypeChange && accountType !== undefined && (
        <div>
          <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">Тип аккаунтов</div>
          <Seg
            options={['managers', 'logists', 'all'] as AccountType[]}
            value={accountType}
            onChange={onAccountTypeChange}
            labels={{ managers: 'Менеджеры', logists: 'Логисты', all: 'Все' }}
          />
        </div>
      )}
      {/* Задача 1569 (владелец, «побаловаться») — экспериментальная сегментация по
          нерабочему времени, МСК. НЕ персистится в SavedReport (см. комментарий у
          пропсов выше) — сбрасывается сменой отчёта, как metricFilters. */}
      {onCreatedTimeFilterChange && createdTimeFilter !== undefined && (
        <div>
          <div
            className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5 cursor-help w-fit"
            title="Время создания сделки (МСК). «Рабочее» — будни 09:00–18:00. «После 18:00» — будни вне этого окна (вечер/ночь). «Выходные» — суббота/воскресенье, весь день. Праздники не учитываются. Экспериментальный фильтр."
          >
            Создана
          </div>
          <Seg
            options={['all', 'business_hours', 'weekday_after_hours', 'weekend'] as CreatedTimeFilter[]}
            value={createdTimeFilter}
            onChange={onCreatedTimeFilterChange}
            labels={{ all: 'Любое', business_hours: 'Рабочее', weekday_after_hours: 'После 18:00', weekend: 'Выходные' }}
          />
        </div>
      )}
      {onFirstTouchFilterChange && firstTouchFilter !== undefined && (
        <div>
          <div
            className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5 cursor-help w-fit"
            title="Момент первого изменения сделки (первое событие в истории стадий) относительно ближайшего открытия офиса (09:00 МСК буднего дня) от времени создания. «Нерабочее» — дежурный обработал ДО открытия. «Рабочее» — обработка сдвинулась на открытие или позже. История событий ведётся с 03.04.2026 — более старые сделки под непустым вариантом не показываются. Экспериментальный фильтр."
          >
            Первая обработка
          </div>
          <Seg
            options={['all', 'off_hours', 'business_hours'] as FirstTouchFilter[]}
            value={firstTouchFilter}
            onChange={onFirstTouchFilterChange}
            labels={{ all: 'Любая', off_hours: 'Нерабочее', business_hours: 'Рабочее' }}
          />
        </div>
      )}
    </div>
  );
}

// Самостоятельный дропдаун «Фильтры» — используется только там, где фильтры остаются
// независимыми от основного отчёта (дрилл-даун, DrilldownDrawer). В основном тулбаре
// отчёта (ReportToolbar) эта кнопка упразднена правкой 09.07 — см. FiltersFields выше.
export function FiltersMenu(props: FiltersFieldsProps) {
  const activeCount = countActiveFilters(props);

  return (
    <Popover
      className="w-60 p-3"
      trigger={
        <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors">
          <Filter size={12} />
          Фильтры
          {activeCount > 0 && (
            <span className="ml-1 px-1.5 py-0.5 bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-full text-[10px]">{activeCount}</span>
          )}
        </button>
      }
    >
      <FiltersFields {...props} />
    </Popover>
  );
}
