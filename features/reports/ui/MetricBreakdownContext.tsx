'use client';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import type { DateRange } from '@/lib/period';
import type { DealFilter } from '@/lib/metrics/dealFilters';
import type { Metric, DealScope, ClientType, ProductGroupMode, AccountType } from '@/lib/metrics/types';

// Контекст полноэкранного «Разбора метрики» (задача владельца 03.09): кнопка
// «Подробнее» в «?» (MetricInfoBody) живёт глубоко в ReportTable/MetricPanel и
// ничего не знает о срезе отчёта — период, фильтры, строки и значения ячеек
// приходят отсюда, от SalesReportPage. Вне провайдера (другие страницы) хук
// отдаёт null, и «?» рисуется без кнопки.

export type BreakdownDimensionType = 'manager' | 'product-group' | 'source' | 'period' | 'client';

export interface BreakdownRow { id: string; name: string }

export interface BreakdownReportContext {
  dimensionType: BreakdownDimensionType;
  /** «По периодам»: разрез строк мини-отчёта — от него зависит, режется ли список типом аккаунтов. */
  periodDimension?: 'managers' | 'product-groups';
  period: DateRange;
  dealScope: DealScope;
  clientType: ClientType;
  productGroupMode: ProductGroupMode;
  departmentIds: string[];
  dealFilters: DealFilter[];
  accountType?: AccountType;
  dealFields?: string[];
  /** Только НЕ групповые строки отчёта (без подытогов отделов/филиалов/групп). */
  rows: BreakdownRow[];
  /** Значение ячейки текущего периода; rowId null — строка «Итого». */
  getCellValue: (metricId: string, rowId: string | null) => number | null;
  openBreakdown: (metric: Metric) => void;
}

export const MetricBreakdownContext = createContext<BreakdownReportContext | null>(null);

export const useMetricBreakdown = () => useContext(MetricBreakdownContext);

// Модал — динамически: он импортирует MetricInfoBody (для «?» у операндов), а
// MetricInfoBody импортирует этот контекст — статический импорт дал бы цикл
// модулей (тот же приём, что CustomerCardLoader в DrilldownDrawer.tsx). Заодно
// тяжёлое дерево списков не попадает в бандл отчёта, пока разбор не открыли.
const MetricBreakdownModal = dynamic(
  () => import('./MetricBreakdownModal').then(m => m.MetricBreakdownModal),
  { ssr: false },
);

/**
 * Держит открытую метрику и САМ рендерит модал: открывать его из поповера «?»
 * нельзя — Radix Popover размонтирует содержимое при закрытии, и модал исчез бы
 * вместе с ним.
 */
export function MetricBreakdownProvider({ value, children }: {
  value: Omit<BreakdownReportContext, 'openBreakdown'>;
  children: ReactNode;
}) {
  const [openMetric, setOpenMetric] = useState<Metric | null>(null);
  const openBreakdown = useCallback((m: Metric) => setOpenMetric(m), []);
  const ctx = useMemo<BreakdownReportContext>(() => ({ ...value, openBreakdown }), [value, openBreakdown]);
  return (
    <MetricBreakdownContext.Provider value={ctx}>
      {children}
      {/* key по id: «Подробнее» у вложенного операнда переключает разбор на другую
          метрику — состояние среза/карточки сделки должно начаться с чистого. */}
      {openMetric && (
        <MetricBreakdownModal key={openMetric.id} metric={openMetric} ctx={ctx} onClose={() => setOpenMetric(null)} />
      )}
    </MetricBreakdownContext.Provider>
  );
}
