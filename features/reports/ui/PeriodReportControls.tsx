'use client';
import type { CalendarUnit } from '@/lib/period';
import type { PeriodsDimension, CompareMode } from '@/features/reports/engine/byPeriods';

// Шапка отчёта «По периодам» (задача владельца 09.08). Три переключателя, которых
// нет и не должно быть у остальных отчётов:
//
//   * ШАГ — во что схлопываются сделки: день/неделя/месяц/квартал/год;
//   * РАЗРЕЗ — куда ведёт дрилл-даун бакета (менеджеры или товарные группы). Он же
//     определяет ОХВАТ строки: в менеджерском разрезе считаются только сделки с
//     менеджером, как в отчёте «По менеджерам», — иначе «Итого» здесь и там
//     разъезжались бы на сделки без ответственного;
//   * СРАВНЕНИЕ — база для колонки «Пред.»: предыдущий такой же период или тот же
//     период год назад. Обычного «периода сравнения» тут нет: строки САМИ являются
//     периодами, и второй диапазон дублировал бы ось.
//
// Раскладка — flex-wrap, а не горизонтальная лента: переключателей мало, перенос на
// вторую строку полностью снимает класс багов с уезжающим скроллом (правило 12
// CLAUDE.md, инцидент 2779).

const UNIT_LABELS: Record<CalendarUnit, string> = {
  day: 'День', week: 'Неделя', month: 'Месяц', quarter: 'Квартал', year: 'Год',
};
const DIMENSION_LABELS: Record<PeriodsDimension, string> = {
  managers: 'Менеджеры', 'product-groups': 'Товарные группы',
};
const COMPARE_LABELS: Record<CompareMode, string> = {
  prev: 'С предыдущим', yoy: 'С прошлым годом', none: 'Без сравнения',
};

function Segmented<T extends string>({ value, options, labels, onChange, ariaLabel }: {
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm max-w-full"
    >
      {options.map(o => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          aria-pressed={value === o}
          className={`px-3 min-h-11 sm:min-h-0 sm:py-1.5 whitespace-nowrap transition-colors ${
            value === o
              ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
              : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
          }`}
        >
          {labels[o]}
        </button>
      ))}
    </div>
  );
}

export function PeriodReportControls({
  unit, onUnitChange,
  dimension, onDimensionChange,
  compareMode, onCompareModeChange,
  bucketCount, unsupportedNames = [],
}: {
  unit: CalendarUnit;
  onUnitChange: (v: CalendarUnit) => void;
  dimension: PeriodsDimension;
  onDimensionChange: (v: PeriodsDimension) => void;
  compareMode: CompareMode;
  onCompareModeChange: (v: CompareMode) => void;
  bucketCount?: number;
  /** Выбранные метрики, которые в разрезе по времени не считаются (планы, звонки,
   *  стадии, снимки «сейчас») — предупреждаем словами, а не пустыми колонками. */
  unsupportedNames?: string[];
}) {
  return (
    <>
    <div className="flex items-center gap-x-4 gap-y-2 px-3 sm:px-6 py-2 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex-wrap">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm text-[var(--color-text-muted)] shrink-0">Шаг</span>
        <Segmented
          ariaLabel="Шаг группировки по времени"
          value={unit}
          options={['day', 'week', 'month', 'quarter', 'year'] as const}
          labels={UNIT_LABELS}
          onChange={onUnitChange}
        />
      </div>

      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm text-[var(--color-text-muted)] shrink-0">Разрез</span>
        <Segmented
          ariaLabel="Разрез дрилл-дауна"
          value={dimension}
          options={['managers', 'product-groups'] as const}
          labels={DIMENSION_LABELS}
          onChange={onDimensionChange}
        />
      </div>

      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm text-[var(--color-text-muted)] shrink-0">Сравнение</span>
        <Segmented
          ariaLabel="База сравнения"
          value={compareMode}
          options={['prev', 'yoy', 'none'] as const}
          labels={COMPARE_LABELS}
          onChange={onCompareModeChange}
        />
      </div>

      {bucketCount !== undefined && (
        <span className="text-xs text-[var(--color-text-muted)]">
          строк: {bucketCount}
        </span>
      )}
    </div>

    {unsupportedNames.length > 0 && (
      <div className="px-3 sm:px-6 py-1.5 text-xs text-[var(--color-text-muted)] bg-[var(--color-bg-surface)] border-b border-[var(--color-border)]">
        В разрезе по времени не считаются (у них свои движки без разбивки по периодам):{' '}
        <span className="text-[var(--color-text)]">{unsupportedNames.join(', ')}</span>
      </div>
    )}
    </>
  );
}
