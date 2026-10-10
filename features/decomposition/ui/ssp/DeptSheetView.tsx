'use client';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SheetBlockResult, SheetResult } from '../../engine/sheetFact';
import type { FunnelSplit } from '../../sheets';
import { C } from './theme';
import {
  Card, CardHead, HeatLegend, Kpi, Loading, Notice, PlanFactTable, fetchJson, fmtDelta, fmtPct, fmtVal, ratioColor, toneColor, unitLabel,
  type Density, type MoneyUnit, type TableLine, type ViewMode,
} from './shared';

// Вкладка листа отдела: карточка на каждый из 18 блоков показателей (как в xlsx,
// одним полотном вниз), в карточке — плитки KPI и таблица по товарным группам.
// Фильтр «Показатель» наверху сужает полотно до одного блока. Движок — engine/sheetFact.ts.

// Показатели, где меньше — лучше: цвета процента инвертируются.
const LOWER_IS_BETTER = new Set(['lost_cnt', 'churn_pct']);

const FORMULAS: Record<string, string> = {
  ship_sum: 'сумма сделок по дате отгрузки',
  sales_sum: 'сумма сделок по дате продажи',
  avg_check: '(сумма продаж + сумма отгрузок) ÷ (кол-во продаж + кол-во отгрузок)',
  ship_cnt: 'кол-во сделок по дате отгрузки',
  sales_cnt: 'кол-во сделок по дате продажи',
  sales_per_day: 'кол-во продаж ÷ рабочие дни',
  lost_cnt: 'кол-во сделок по дате отказа',
  deals_cnt: 'созданные сделки первичных воронок',
  deals_per_day: 'первичные сделки ÷ рабочие дни',
  mops: 'менеджеры отдела с созданными сделками в месяце (оценка)',
  leads: 'факта в базе нет — только план',
  leads_per_day: 'факта в базе нет — только план',
  site_visits: 'факта в базе нет — только план',
  cv_deal_sale: 'продажи ÷ первичные сделки',
  cv_sale_ship: 'отгрузки ÷ продажи',
  cv_deal_ship: 'отгрузки ÷ первичные сделки',
  cv_ship_closed: 'отгрузки ÷ (отгрузки + отказы)',
  churn_pct: '(продажи − отгрузки) ÷ продажи',
};

export const blockAnchor = (key: string) => `ssp-block-${key}`;

function BlockCard({ block, split, cal, view, money, density }: {
  block: SheetBlockResult; split: FunnelSplit; cal: SheetResult; view: ViewMode; money: MoneyUnit; density: Density;
}) {
  const effSplit: FunnelSplit = block.hasSplit ? split : 'all';
  const splitData = block.splits[effSplit] ?? block.splits.all;
  const lines = useMemo<TableLine[]>(() => {
    if (!splitData) return [];
    const toLine = (l: typeof splitData.total, level: TableLine['level'], key: string): TableLine => ({
      key, label: l.label, level, planMonths: l.planMonths, planYear: l.planYear, factMonths: l.factMonths,
      factYtd: l.factYtd, planToDate: l.planToDate, muted: l.extra, note: l.extra ? 'Товарные группы, для которых в листе нет строки.' : undefined,
    });
    return [toLine(splitData.total, 'total', '__total__'), ...splitData.rows.map((r, i) => toLine(r, 'row', `${i}:${r.label}`))];
  }, [splitData]);
  if (!splitData) return null;

  const total = splitData.total;
  const lower = LOWER_IS_BETTER.has(block.key);
  const delta = total.factYtd !== null && total.planToDate !== null ? total.factYtd - total.planToDate : null;
  const hint = [
    FORMULAS[block.key],
    block.hasSplit && effSplit !== 'all' ? (effSplit === 'primary' ? 'первичные' : 'повторные') : null,
    !block.hasSplit && split !== 'all' ? 'без разбивки по воронкам' : null,
  ].filter(Boolean).join(' · ');

  return (
    // content-visibility: 18 широких таблиц подряд — браузер раскладывает только видимые.
    <div id={blockAnchor(block.key)} className="scroll-mt-4 [content-visibility:auto] [contain-intrinsic-size:auto_640px]">
      <Card>
        <CardHead title={block.label} hint={hint} />
        <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <Kpi label="План к дате" value={fmtVal(total.planToDate, block.unit, money)} sub={unitLabel(block.unit, money)} />
          <Kpi
            label="Факт с начала года"
            value={fmtVal(total.factYtd, block.unit, money)}
            sub={block.factAvailable ? `выполнение ${fmtPct(total.factYtd, total.planToDate)}` : 'факт не считается'}
            color={ratioColor(total.factYtd, total.planToDate, lower)}
          />
          <Kpi label="Отклонение" value={fmtDelta(delta, block.unit, money)} sub="факт − план к дате" color={toneColor(delta, lower)} />
          <Kpi label="План на год" value={fmtVal(total.planYear, block.unit, money)} sub={block.kind === 'sum' ? `сделано ${fmtPct(total.factYtd, total.planYear)} года` : 'из листа'} />
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <HeatLegend lowerIsBetter={lower} />
          <PlanFactTable lines={lines} cal={cal} kind={block.kind} unit={block.unit} money={money} view={view} density={density} lowerIsBetter={lower} />
        </div>
      </Card>
    </div>
  );
}

export function DeptSheetView({ sheet, split, blockKey, view, money, density, onBlocks }: {
  sheet: string; split: FunnelSplit; blockKey: string; view: ViewMode; money: MoneyUnit; density: Density;
  /** Список блоков листа для фильтра «Показатель» в шапке страницы. */
  onBlocks?: (blocks: { key: string; label: string; factAvailable: boolean }[]) => void;
}) {
  const { data, isLoading, isError, error } = useQuery<SheetResult>({
    queryKey: ['decomposition-sheet', sheet],
    queryFn: async () => {
      const res = await fetchJson<SheetResult>(`/api/decomposition/sheet?sheet=${encodeURIComponent(sheet)}`);
      onBlocks?.(res.blocks.map(b => ({ key: b.key, label: b.label, factAvailable: b.factAvailable })));
      return res;
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (isLoading) return <Loading text={`Считаем «${sheet}»…`} />;
  if (isError) return <Notice tone="error">Не удалось загрузить лист: {(error as Error)?.message}</Notice>;
  if (!data) return null;

  const blocks = blockKey === 'all' ? data.blocks : data.blocks.filter(b => b.key === blockKey);

  return (
    <>
      {!data.factAvailable && <Notice tone="warn">{data.note ?? 'Для этого листа факт не считается — показан только план.'}</Notice>}
      {data.factAvailable && data.note && <Notice>{data.note}</Notice>}
      {blocks.map(b => (
        <BlockCard key={b.key} block={b} split={split} cal={data} view={view} money={money} density={density} />
      ))}
      <p className="max-w-4xl text-[12px] font-medium" style={{ color: C.muted }}>
        План — лист «{sheet}» файла «{data.sourceFile}». Первичные/повторные — по воронке сделки. Для показателей-отношений
        «план к дате» — среднее планов прошедших месяцев, «% месяца» — против плана месяца целиком. Товарные группы сопоставлены по
        названию группы сделки; группы без строки в листе идут в «Другие товары (…)», а если такой строки нет — в «Прочее (вне листа)».
      </p>
    </>
  );
}
