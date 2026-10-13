'use client';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PlanFactResult } from '../../engine/planFact';
import { C } from './theme';
import {
  Card, CardHead, HeatLegend, Kpi, Loading, Notice, PlanFactTable, fetchJson, fmtDelta, fmtPct, fmtVal, ratioColor, toneColor,
  type Density, type MoneyUnit, type TableLine, type ViewMode,
} from './shared';

// Вкладка «Общая»: лист «Общая» декомпозиции (филиалы × отделы) против факта
// отгрузок по месяцам — движок engine/planFact.ts.
export function OverviewView({ view, money, density }: { view: ViewMode; money: MoneyUnit; density: Density }) {
  const { data, isLoading, isError, error } = useQuery<PlanFactResult>({
    queryKey: ['decomposition-plan-fact'],
    queryFn: () => fetchJson<PlanFactResult>('/api/decomposition/plan-fact'),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const lines = useMemo<TableLine[]>(() => (data?.rows ?? []).map(r => ({
    key: r.key,
    label: r.label,
    level: r.level === 'russia' ? 'total' : r.level === 'branch' ? 'group' : 'row',
    planMonths: r.planMonths,
    planYear: r.planYear,
    factMonths: r.factMonths.map((v, i) => (i <= (data?.currentMonth ?? -1) ? v : null)),
    factYtd: r.factYtd,
    planToDate: r.planToDate,
    note: r.note,
  })), [data]);
  const notes = useMemo(() => (data?.rows ?? []).filter(r => r.note).map(r => `${r.label}: ${r.note}`), [data]);

  if (isLoading) return <Loading text="Считаем факт отгрузок за год…" />;
  if (isError) return <Notice tone="error">Не удалось загрузить данные: {(error as Error)?.message}</Notice>;
  if (!data) return null;
  const russia = data.rows.find(r => r.level === 'russia');
  if (!russia) return null;
  const delta = russia.factYtd - (russia.planToDate ?? 0);
  const unit = money === 'mln' ? 'млн ₽' : '₽';

  return (
    <Card>
      <CardHead title="Отгрузки по филиалам и отделам" hint="лист «Общая» · план и факт, накопительно с начала года" />
      <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-5">
        <Kpi label="Факт с начала года" value={fmtVal(russia.factYtd, 'money', money)} sub={unit} />
        <Kpi label="План к дате" value={fmtVal(russia.planToDate, 'money', money)} sub={`выполнение ${fmtPct(russia.factYtd, russia.planToDate)}`} color={ratioColor(russia.factYtd, russia.planToDate)} />
        <Kpi label="Отклонение" value={fmtDelta(delta, 'money', money)} sub="факт − план к дате" color={toneColor(delta)} />
        <Kpi label="План на год" value={fmtVal(russia.planYear, 'money', money)} sub={`сделано ${fmtPct(russia.factYtd, russia.planYear)} года`} />
        <Kpi
          label="Прогноз года по темпу"
          value={russia.planToDate ? fmtVal((russia.factYtd / russia.planToDate) * (russia.planYear ?? 0), 'money', money) : '—'}
          sub="если держать текущий темп"
          color={ratioColor(russia.factYtd, russia.planToDate)}
        />
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <HeatLegend />
        <PlanFactTable lines={lines} cal={data} kind="sum" unit="money" money={money} view={view} density={density} />
      </div>
      <div className="mt-3 flex max-w-4xl flex-col gap-1 text-[12px] font-medium" style={{ color: C.muted }}>
        <p>
          Факт — сумма отгрузок (первичные + повторные) по дате отгрузки, разложенная по филиалам и отделам так же, как в «Сводной».
          «План к дате» — завершённые месяцы целиком плюс текущий пропорционально прошедшим рабочим дням.
        </p>
        {notes.map(n => <p key={n}>* {n}</p>)}
      </div>
    </Card>
  );
}
