'use client';

import { useState } from 'react';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SlideBackdrop } from '@/components/ui/SlideBackdrop';
import { DealsListBody, type Deal } from '@/features/reports/ui/DrilldownDrawer';
import { DealCard } from '@/features/reports/ui/DealCard';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, ProductGroupMode } from '@/lib/metrics/types';

// Дрилл-даун списка сделок по клику на когорту графика (задача 2546, владелец
// 29.07: «при нажатии на любую когорту на графиках появлялся список сделок»).
// Переиспользует DealsListBody/DealsTable из существующего дрилл-дауна отчётов
// (features/reports/ui/DrilldownDrawer.tsx) — те же колонки, ссылка на Bitrix,
// сортировка, LIMIT 1000 с «показаны первые N из M». Отдельная (не
// DrilldownDrawer целиком) панель — тому нужны metricIds/dimensionType/
// grouping, которых у корзины графика попросту нет (плоский список, не
// мини-отчёт).
//
// У каждой корзины два числа (см. спеку docs/specs/charts-cohort-drilldown.md):
// «Все N» — весь бакет (совпадает с высотой серого столбика), «Продано M» —
// только продавшие (совпадает со второй цифрой тултипа). Оба уже известны из
// уже загруженных данных графика — сегментированный переключатель ниже не
// делает лишнего запроса на подсчёт, только на сам список.

export interface ChartDrilldownRequest {
  endpoint: '/api/charts/stage-survival/deals' | '/api/charts/called-to-sale-cohort/deals' | '/api/charts/work-days-cohort/deals' | '/api/charts/work-excl-reserved-cohort/deals';
  // Базовое тело запроса БЕЗ filter — filter подставляется переключателем.
  baseBody: Record<string, unknown>;
  period: DateRange;
  dealScope: DealScope;
  clientType: ClientType;
  productGroupMode: ProductGroupMode;
  productGroupIds: string[];
  departmentIds: string[];
}

// Опция сегментированного переключателя (задача 2574, доработка 30.07 —
// пятый график получил ТРИ линии вместо одной, «Все/Продано» на две кнопки
// стало не хватать). key уходит в тело запроса СРАЗУ ДВУМЯ полями — `filter`
// (что читают stage-survival/called-to-sale-cohort/work-days-cohort — там
// значения только 'all'|'sold') и `kind` (что читает work-excl-reserved-cohort
// — там 'all'|'reserved'|'sold'|'shipped'). Один endpoint читает своё поле,
// второе игнорирует — не пришлось заводить два разных типа запроса.
export interface ChartDrilldownOption {
  key: string;
  label: string;
  count: number;
}

export interface ChartDrilldownTarget {
  title: string;       // «День 5» / «13 дн. в стадии»
  subtitle: string;     // название графика/пресета
  // Легаси-форма (2 кнопки «Все N»/«Продано M») — используется 1-м/3-м/4-м
  // графиками. Для 5-го (3 линии) вместо неё — options ниже.
  allCount?: number;
  soldCount?: number;
  // Общая форма (N кнопок) — задать options ЛИБО allCount/soldCount, не оба.
  options?: ChartDrilldownOption[];
  request: ChartDrilldownRequest;
}

function resolveOptions(target: ChartDrilldownTarget): ChartDrilldownOption[] {
  if (target.options?.length) return target.options;
  return [
    { key: 'all', label: 'Все', count: target.allCount ?? 0 },
    { key: 'sold', label: 'Продано', count: target.soldCount ?? 0 },
  ];
}

async function fetchChartDeals(req: ChartDrilldownRequest, key: string): Promise<{ deals: Deal[]; total_count: number; total_amount: number }> {
  const res = await fetch(req.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...req.baseBody,
      filter: key,
      kind: key,
      period: { from: req.period.from, to: req.period.to },
      dealScope: req.dealScope,
      clientType: req.clientType,
      departmentIds: req.departmentIds,
      productGroupMode: req.productGroupMode,
      productGroupIds: req.productGroupIds,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function ChartDrilldownPanel({ target, onClose }: { target: ChartDrilldownTarget; onClose: () => void }) {
  const { closing, requestClose } = useSlideClose(onClose);
  const options = resolveOptions(target);
  const [selected, setSelected] = useState<string>(options[0].key);
  const [openDealId, setOpenDealId] = useState<number | null>(null);
  const selectedOption = options.find(o => o.key === selected) ?? options[0];

  return (
    <div className="fixed inset-0 z-[60]">
      <SlideBackdrop closing={closing} onClick={requestClose} className="z-[60]" />
      <div className={`fixed inset-y-0 right-0 z-[61] w-full sm:w-[70vw] sm:min-w-[720px] sm:max-w-[1200px] bg-[var(--color-bg)] shadow-2xl border-l border-[var(--color-border)] flex flex-col ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}>
        <PanelCloseTab onClick={requestClose} />
        <div className="flex items-center justify-between flex-wrap gap-y-2 px-3 sm:px-6 py-3 sm:py-4 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-[var(--color-text)] text-base truncate">{target.title}</h2>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5 truncate">{target.subtitle}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
              {options.map(o => (
                <button
                  key={o.key}
                  onClick={() => setSelected(o.key)}
                  className={`px-2.5 py-1 transition-colors whitespace-nowrap ${selected === o.key ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
                >
                  {o.label} {o.count.toLocaleString('ru-RU')}
                </button>
              ))}
            </div>
            <button onClick={requestClose} className="sm:hidden p-2 hover:bg-[var(--color-bg-hover)] rounded-lg transition-colors" aria-label="Закрыть">×</button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          <DealsListBody
            fetchOverride={{
              key: [target.request.endpoint, JSON.stringify(target.request.baseBody), selected, target.request.period.from, target.request.period.to,
                target.request.dealScope, target.request.clientType, target.request.productGroupMode, target.request.productGroupIds, target.request.departmentIds],
              fn: () => fetchChartDeals(target.request, selected),
            }}
            onDealOpen={setOpenDealId}
            emptyLabel={selected === 'all' ? 'Нет сделок в этой когорте' : `Нет сделок в «${selectedOption.label}» на этот день`}
          />
        </div>
      </div>
      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} />}
    </div>
  );
}
