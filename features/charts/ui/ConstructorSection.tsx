'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Check } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Seg } from '@/features/reports/ui/FiltersMenu';
import { computeCalculated } from '@/features/reports/engine/calculated';
import type { Metric, ReportRow, DealScope, ClientType } from '@/lib/metrics/types';
import type { DateRange } from '@/lib/period';
import {
  HBarChart, LineChart, ScatterChart, ChartLegend,
  type ChartEntity,
} from './ConstructorChart';

// Конструктор графиков (раздел «Графики», задача 28.07): любой известной метрике —
// ось; данные — тот же /api/reports/run, что у отчётов (никакого второго расчёта).
type ChartMode = 'by-managers' | 'by-product-groups';
type ChartType = 'bar' | 'line' | 'scatter';
type ChartGrouping = 'none' | 'team' | 'branch';

const TOP_N = 30;

interface RunResponse {
  rows: ReportRow[];
  metrics: Metric[];
}

interface Props {
  period: DateRange;
  dealScope: DealScope;
  clientType: ClientType;
  departmentIds: string[];
  departmentsReady: boolean;
}

// ── Пикер метрик (Popover по правилу CLAUDE.md №4) ───────────────────────────
function MetricPicker({
  metrics, selected, onChange, multi, label,
}: {
  metrics: Metric[];
  selected: string[];
  onChange: (ids: string[]) => void;
  multi: boolean;
  label: string;
}) {
  const [search, setSearch] = useState('');
  const byCategory = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? metrics.filter(m => m.nameRu.toLowerCase().includes(q)) : metrics;
    const groups = new Map<string, Metric[]>();
    for (const m of filtered) {
      const cat = m.category || 'Прочее';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(m);
    }
    return [...groups.entries()];
  }, [metrics, search]);

  const selectedNames = metrics.filter(m => selected.includes(m.id)).map(m => m.nameShortRu || m.nameRu);
  const summary = selectedNames.length === 0
    ? 'Выберите метрику'
    : selectedNames.length <= 2 ? selectedNames.join(', ') : `${selectedNames.length} метрики`;

  return (
    <Popover
      className="w-[320px] max-w-[calc(100vw-16px)] p-0"
      trigger={
        <button
          type="button"
          className="inline-flex items-center gap-1.5 border border-[var(--color-border)] rounded-lg px-2.5 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] max-w-full"
        >
          <span className="text-[var(--color-text-muted)] shrink-0">{label}:</span>
          <span className="truncate">{summary}</span>
          <ChevronDown size={13} className="shrink-0 text-[var(--color-text-muted)]" />
        </button>
      }
    >
      <div className="p-2 border-b border-[var(--color-border)]">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Поиск метрики…"
          className="w-full text-base sm:text-sm border border-[var(--color-border)] rounded-md px-2 py-1 bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
      </div>
      <div className="max-h-72 overflow-y-auto p-1">
        {byCategory.map(([cat, ms]) => (
          <div key={cat}>
            <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{cat}</div>
            {ms.map(m => {
              const isSel = selected.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    if (multi) {
                      onChange(isSel ? selected.filter(id => id !== m.id) : [...selected, m.id].slice(-4));
                    } else {
                      onChange([m.id]);
                    }
                  }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs ${isSel ? 'bg-[var(--color-sidebar-active-bg)] text-[var(--color-sidebar-active)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
                >
                  <span className={`w-3.5 shrink-0 ${isSel ? '' : 'opacity-0'}`}><Check size={14} /></span>
                  <span className="flex-1 min-w-0 break-words">{m.nameRu}</span>
                </button>
              );
            })}
          </div>
        ))}
        {byCategory.length === 0 && (
          <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">Ничего не найдено</div>
        )}
      </div>
    </Popover>
  );
}

// Клиентская группировка строк по отделу/филиалу: collected/external с
// aggregation_fn='sum' складываются, calculated пересчитываются формулой от сумм
// (тот же принцип, что applyClientGrouping в SalesReportPage) — среднее процентов
// НЕ берётся.
function groupRows(rows: ReportRow[], grouping: ChartGrouping, catalog: Metric[]): ReportRow[] {
  if (grouping === 'none') return rows;
  const keyOf = (r: ReportRow) => grouping === 'team' ? (r.teamName ?? '—') : (r.branchName ?? '—');
  const calculated = catalog.filter(m => m.metricType === 'calculated');
  const summable = new Set(catalog.filter(m => m.metricType !== 'calculated' && m.aggregationFn === 'sum').map(m => m.id));

  const groups = new Map<string, ReportRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  return [...groups.entries()].map(([name, rs]) => {
    const sums: Record<string, number | null> = {};
    for (const r of rs) {
      for (const [id, v] of Object.entries(r.metrics)) {
        if (!summable.has(id)) continue;
        if (v === null) continue;
        sums[id] = (sums[id] ?? 0) + v;
      }
    }
    return {
      dimensionId: `grp:${name}`,
      dimensionName: name,
      teamId: null, teamName: null, branchName: null,
      metrics: computeCalculated(sums, calculated),
    } as ReportRow;
  });
}

export function ConstructorSection({ period, dealScope, clientType, departmentIds, departmentsReady }: Props) {
  const [mode, setMode] = useState<ChartMode>('by-managers');
  const [chartType, setChartType] = useState<ChartType>('bar');
  const [grouping, setGrouping] = useState<ChartGrouping>('none');
  // дефолты — заведомо активные метрики каталога (primary_sales_amount, например,
  // в каталоге выключена is_active=false)
  const [yMetricIds, setYMetricIds] = useState<string[]>(['all_sales_amount']);
  const [xMetricId, setXMetricId] = useState<string>('sales_count');

  const { data: catalogData } = useQuery<{ metrics: Metric[] }>({
    queryKey: ['catalog/metrics'],
    queryFn: async () => {
      const res = await fetch('/api/catalog/metrics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
  // Полный каталог — для математики группировки (суммы зависимостей calculated-метрик:
  // например, у активной «Сумма продаж (все)» слагаемые primary/repeat_sales_amount
  // в каталоге ВЫКЛЮЧЕНЫ — фильтровать их из расчёта нельзя, иначе группы пустеют).
  // В пикер — только активные.
  const catalog = useMemo(() => catalogData?.metrics ?? [], [catalogData]);
  const pickerMetrics = useMemo(() => catalog.filter(m => m.isActive), [catalog]);

  const requestedIds = useMemo(() => {
    const ids = [...yMetricIds];
    if (chartType === 'scatter' && xMetricId) ids.push(xMetricId);
    return [...new Set(ids)].sort();
  }, [yMetricIds, xMetricId, chartType]);

  const { data, isLoading, isError } = useQuery<RunResponse>({
    queryKey: ['charts-run', mode, period, requestedIds, dealScope, clientType, departmentIds],
    queryFn: async () => {
      const res = await fetch('/api/reports/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportSlug: mode,
          period: { from: period.from, to: period.to },
          // сравнение конструктору не нужно, но run его требует — шлём тот же период
          comparisonPeriod: { from: period.from, to: period.to },
          metricIds: requestedIds,
          dealScope, clientType, departmentIds,
          productGroupMode: 'kc',
          accountType: 'managers',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: departmentsReady && requestedIds.length > 0,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const yMetrics = yMetricIds
    .map(id => catalog.find(m => m.id === id))
    .filter((m): m is Metric => !!m);
  const xMetric = catalog.find(m => m.id === xMetricId);

  const entities: ChartEntity[] = useMemo(() => {
    if (!data?.rows) return [];
    const grouped = mode === 'by-managers' ? groupRows(data.rows, grouping, catalog) : data.rows;
    const list = grouped.map(r => ({
      id: r.dimensionId,
      name: r.dimensionName,
      values: yMetricIds.map(id => r.metrics[id] ?? null),
      x: xMetricId ? (r.metrics[xMetricId] ?? null) : null,
    }));
    const sorted = list.sort((a, b) => (b.values[0] ?? -Infinity) - (a.values[0] ?? -Infinity));
    if (chartType === 'scatter') return sorted;
    return sorted.filter(e => e.values.some(v => v !== null)).slice(0, TOP_N);
  }, [data, mode, grouping, catalog, yMetricIds, xMetricId, chartType]);

  const hasAnyValue = entities.some(e => e.values.some(v => v !== null) || e.x !== null);

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 sm:p-5">
      {/* панель управления конструктором */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Seg<ChartMode>
          options={['by-managers', 'by-product-groups']}
          value={mode}
          onChange={m => { setMode(m); if (m === 'by-product-groups') setGrouping('none'); }}
          labels={{ 'by-managers': 'По менеджерам', 'by-product-groups': 'По товарам' }}
        />
        <Seg<ChartType>
          options={['bar', 'line', 'scatter']}
          value={chartType}
          onChange={setChartType}
          labels={{ bar: 'Полосы', line: 'Линия', scatter: 'Рассеяние' }}
        />
        {mode === 'by-managers' && (
          <Seg<ChartGrouping>
            options={['none', 'team', 'branch']}
            value={grouping}
            onChange={setGrouping}
            labels={{ none: 'Без групп.', team: 'По отделу', branch: 'По филиалу' }}
          />
        )}
        <MetricPicker
          metrics={pickerMetrics}
          selected={yMetricIds}
          onChange={ids => setYMetricIds(ids.length ? ids : yMetricIds)}
          multi={chartType !== 'scatter'}
          label={chartType === 'scatter' ? 'Ось Y' : 'Метрики'}
        />
        {chartType === 'scatter' && (
          <MetricPicker
            metrics={pickerMetrics}
            selected={xMetricId ? [xMetricId] : []}
            onChange={ids => setXMetricId(ids[0] ?? xMetricId)}
            multi={false}
            label="Ось X"
          />
        )}
      </div>

      {chartType !== 'scatter' && <ChartLegend metrics={yMetrics} />}

      {isLoading ? (
        <div className="h-[260px] rounded-lg bg-[var(--color-border)] animate-pulse" />
      ) : isError ? (
        <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить данные.</p>
      ) : !hasAnyValue ? (
        <p className="text-sm text-[var(--color-text-muted)] py-8 text-center">
          Нет данных под выбранные фильтры и метрики.
          {mode === 'by-product-groups' && ' Часть метрик (планы, звонки, стадии) считается только по менеджерам.'}
        </p>
      ) : chartType === 'bar' ? (
        <HBarChart entities={entities} metrics={yMetrics} />
      ) : chartType === 'line' ? (
        <LineChart entities={entities} metrics={yMetrics} />
      ) : (xMetric && yMetrics[0]) ? (
        <ScatterChart entities={entities} xMetric={xMetric} yMetric={yMetrics[0]} />
      ) : (
        <p className="text-sm text-[var(--color-text-muted)]">Выберите метрики для осей.</p>
      )}

      {chartType !== 'scatter' && entities.length === TOP_N && (
        <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">Показан топ-{TOP_N} по первой метрике.</p>
      )}
    </section>
  );
}
