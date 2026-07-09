'use client';
import { Filter } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import type { DealScope, ClientType, ProductGroupMode, AccountType } from '@/lib/metrics/types';

export function Seg<T extends string>({ options, value, onChange, labels }: {
  options: T[]; value: T; onChange: (v: T) => void; labels: Record<T, string>;
}) {
  return (
    <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
      {options.map(o => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`flex-1 px-2 py-1.5 transition-colors whitespace-nowrap ${value === o ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
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
}

// Кол-во нефолтовых фильтров → бейдж (виден без открытия панели). Дефолты: все сделки,
// все клиенты, «По наибольшему» (by_max), «Менеджеры». Вынесено отдельной функцией
// (правка 09.07, объединение «Фильтры»+«Вид» в «Настройки отчёта»), чтобы кнопка
// объединённой панели в ReportToolbar считала бейдж тем же способом, что и раньше
// FiltersMenu, без дублирования условий.
export function countActiveFilters({ dealScope, clientType, showProductGroupPicker, productGroupMode, accountType, onAccountTypeChange }: FiltersFieldsProps): number {
  return (dealScope !== 'all' ? 1 : 0) + (clientType !== 'all' ? 1 : 0)
    + (showProductGroupPicker && productGroupMode && productGroupMode !== 'by_max' ? 1 : 0)
    + (onAccountTypeChange && accountType && accountType !== 'managers' ? 1 : 0);
}

// Содержимое «Фильтры» — вынесено из-под Popover-обёртки (правка 09.07), чтобы
// использовать И в самостоятельном дропдауне (FiltersMenu ниже, свои независимые
// фильтры дрилл-дауна), И в объединённой панели «Настройки отчёта»
// (ReportSettingsPanel — левая колонка основного тулбара), без дублирования разметки.
export function FiltersFields({ dealScope, onDealScopeChange, clientType, onClientTypeChange, productGroupMode, onProductGroupModeChange, showProductGroupPicker, accountType, onAccountTypeChange }: FiltersFieldsProps) {
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
            <span className="ml-1 px-1.5 py-0.5 bg-[var(--color-accent)] text-white rounded-full text-[10px]">{activeCount}</span>
          )}
        </button>
      }
    >
      <FiltersFields {...props} />
    </Popover>
  );
}
