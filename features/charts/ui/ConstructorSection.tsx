'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Check } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Seg } from '@/features/reports/ui/FiltersMenu';
import { computeCalculated } from '@/features/reports/engine/calculated';
import type { Metric, ReportRow, DealScope, ClientType, ProductGroupMode } from '@/lib/metrics/types';
import type { DateRange } from '@/lib/period';
import {
  HBarChart, LineChart, ScatterChart, ChartLegend,
  type ChartEntity,
} from './ConstructorChart';

// Конструктор графиков (раздел «Графики», задача 28.07): любой известной метрике —
// ось; данные — тот же /api/reports/run, что у отчётов (никакого второго расчёта).
type ChartMode = 'by-managers' | 'by-product-groups' | 'by-amount-buckets';
type ChartType = 'bar' | 'line' | 'scatter';
type ChartGrouping = 'none' | 'team' | 'branch';

const TOP_N = 30;

interface RunResponse {
  rows: ReportRow[];
  metrics: Metric[];
}

export interface SavedChartConfig {
  mode: string; chartType: string; grouping: string;
  yMetricIds: string[]; xMetricId: string | null;
  dealScope: string; clientType: string;
  productGroupMode: string; productGroupIds: string[];
}

interface Props {
  period: DateRange;
  dealScope: DealScope;
  clientType: ClientType;
  departmentIds: string[];
  departmentsReady: boolean;
  /** Загрузка сохранённого графика применяет и пилюли страницы (первичные/Б2Б/
   *  товарные группы) — они часть смысла графика, без них он «не тот». */
  onApplyPageFilters: (cfg: SavedChartConfig) => void;
  // Фильтр товарных групп (задача 29.07) — раньше productGroupMode был ЖЁСТКО
  // захардкожен 'kc' в теле запроса ниже; теперь приходит из общего фильтра
  // раздела «Графики» (ChartsPage), применяется к обеим вкладкам одинаково.
  productGroupMode: ProductGroupMode;
  productGroupIds: string[];
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

interface SavedChart { id: string; name: string; config: SavedChartConfig }

export function ConstructorSection({ period, dealScope, clientType, departmentIds, departmentsReady, productGroupMode, productGroupIds, onApplyPageFilters }: Props) {
  // Дефолт (задача владельца 18.08): зависимость конверсии в продажу от суммы
  // сделки. Пилюли страницы уже по умолчанию «Первичные»; шкалу групп «по
  // наибольшему» при первом входе слать не пытаемся — это настройка страницы.
  const [mode, setMode] = useState<ChartMode>('by-amount-buckets');
  const [chartType, setChartType] = useState<ChartType>('bar');
  const [grouping, setGrouping] = useState<ChartGrouping>('none');
  const [yMetricIds, setYMetricIds] = useState<string[]>(['cr_deal_to_sale_all']);
  const [xMetricId, setXMetricId] = useState<string>('sales_count');

  const qc = useQueryClient();
  const { data: savedData } = useQuery<{ charts: SavedChart[] }>({
    queryKey: ['charts-saved'],
    queryFn: async () => {
      const res = await fetch('/api/charts/saved');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });
  const savedCharts = savedData?.charts ?? [];
  const [saveName, setSaveName] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  async function saveChart() {
    const name = saveName.trim();
    if (!name || saving) return;
    setSaving(true);
    try {
      const config: SavedChartConfig = {
        mode, chartType, grouping, yMetricIds, xMetricId,
        dealScope, clientType, productGroupMode, productGroupIds,
      };
      const res = await fetch('/api/charts/saved', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, config }),
      });
      if (res.ok) {
        setSaveOpen(false); setSaveName('');
        void qc.invalidateQueries({ queryKey: ['charts-saved'] });
      }
    } finally { setSaving(false); }
  }

  function loadChart(c: SavedChart) {
    const cfg = c.config;
    if (cfg.mode === 'by-managers' || cfg.mode === 'by-product-groups' || cfg.mode === 'by-amount-buckets') setMode(cfg.mode);
    if (cfg.chartType === 'bar' || cfg.chartType === 'line' || cfg.chartType === 'scatter') setChartType(cfg.chartType);
    if (cfg.grouping === 'none' || cfg.grouping === 'team' || cfg.grouping === 'branch') setGrouping(cfg.grouping);
    if (cfg.yMetricIds?.length) setYMetricIds(cfg.yMetricIds);
    if (cfg.xMetricId) setXMetricId(cfg.xMetricId);
    onApplyPageFilters(cfg); // пилюли страницы — часть смысла графика
  }

  async function deleteChart(id: string) {
    await fetch(`/api/charts/saved?id=${id}`, { method: 'DELETE' });
    void qc.invalidateQueries({ queryKey: ['charts-saved'] });
  }

  const { data: catalogData } = useQuery<{ metrics: Metric[] }>({
    queryKey: ['catalog/metrics'],
    queryFn: async () => {
      const res = await fetch('/api/catalog/metrics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
  // Полный каталог — для математики группировки (см. комментарий в groupRows);
  // в пикер — только активные.
  const catalog = useMemo(() => catalogData?.metrics ?? [], [catalogData]);
  const pickerMetrics = useMemo(() => catalog.filter(m => m.isActive), [catalog]);

  // Рассеяние по корзинам сумм смысла не имеет (X там и есть сумма сделки) —
  // при переключении на корзины скаттер мягко падает в полосы.
  const effectiveChartType = mode === 'by-amount-buckets' && chartType === 'scatter' ? 'bar' : chartType;

  const requestedIds = useMemo(() => {
    const ids = [...yMetricIds];
    if (effectiveChartType === 'scatter' && xMetricId) ids.push(xMetricId);
    return [...new Set(ids)].sort();
  }, [yMetricIds, xMetricId, effectiveChartType]);

  const { data, isLoading, isError } = useQuery<RunResponse>({
    queryKey: ['charts-run', mode, period, requestedIds, dealScope, clientType, departmentIds, productGroupMode, productGroupIds],
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
          productGroupMode, productGroupIds,
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
    // Корзины сумм — ФИКСИРОВАННЫЙ порядок по номеру корзины (от дешёвых к дорогим),
    // сортировка по значению превратила бы ось X в кашу.
    if (mode === 'by-amount-buckets') {
      return list.sort((a, b) => Number(a.id) - Number(b.id));
    }
    const sorted = list.sort((a, b) => (b.values[0] ?? -Infinity) - (a.values[0] ?? -Infinity));
    if (effectiveChartType === 'scatter') return sorted;
    return sorted.filter(e => e.values.some(v => v !== null)).slice(0, TOP_N);
  }, [data, mode, grouping, catalog, yMetricIds, xMetricId, effectiveChartType]);

  const hasAnyValue = entities.some(e => e.values.some(v => v !== null) || e.x !== null);

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 sm:p-5">
      {/* сохранённые графики — пилюли, как сохранённые отчёты */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {savedCharts.map(c => (
          <span key={c.id} className="inline-flex items-center rounded-full border border-[var(--color-border)] text-xs">
            <button
              type="button"
              onClick={() => loadChart(c)}
              className="pl-2.5 pr-1 py-1 text-[var(--color-text)] hover:text-[var(--color-accent)]"
            >
              {c.name}
            </button>
            <button
              type="button"
              aria-label={`Удалить график «${c.name}»`}
              onClick={() => void deleteChart(c.id)}
              className="tap-target px-1.5 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-negative)]"
            >
              ×
            </button>
          </span>
        ))}
        <Popover
          open={saveOpen}
          onOpenChange={setSaveOpen}
          className="w-[260px] p-2"
          trigger={
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-focus)]"
            >
              + Сохранить график
            </button>
          }
        >
          <div className="flex flex-col gap-2">
            <input
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void saveChart(); }}
              placeholder="Название графика…"
              className="w-full text-[16px] sm:text-sm border border-[var(--color-border)] rounded-md px-2 py-1.5 bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
            <p className="text-[11px] text-[var(--color-text-muted)] m-0">
              Сохранится всё: оси, тип, пилюли и товарные группы. Период — нет.
            </p>
            <button
              type="button"
              onClick={() => void saveChart()}
              disabled={!saveName.trim() || saving}
              className="min-h-11 sm:min-h-0 rounded-md bg-[var(--color-accent)] text-white text-sm py-1.5 disabled:opacity-50"
            >
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
        </Popover>
      </div>

      {/* панель управления конструктором */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Seg<ChartMode>
          options={['by-managers', 'by-product-groups', 'by-amount-buckets']}
          value={mode}
          onChange={m => { setMode(m); if (m !== 'by-managers') setGrouping('none'); }}
          labels={{ 'by-managers': 'По менеджерам', 'by-product-groups': 'По товарам', 'by-amount-buckets': 'По сумме сделки' }}
        />
        <Seg<ChartType>
          options={mode === 'by-amount-buckets' ? ['bar', 'line'] : ['bar', 'line', 'scatter']}
          value={effectiveChartType}
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
          multi={effectiveChartType !== 'scatter'}
          label={effectiveChartType === 'scatter' ? 'Ось Y' : mode === 'by-amount-buckets' ? 'Ось Y (по корзинам чека)' : 'Метрики'}
        />
        {effectiveChartType === 'scatter' && (
          <MetricPicker
            metrics={pickerMetrics}
            selected={xMetricId ? [xMetricId] : []}
            onChange={ids => setXMetricId(ids[0] ?? xMetricId)}
            multi={false}
            label="Ось X"
          />
        )}
      </div>

      {effectiveChartType !== 'scatter' && <ChartLegend metrics={yMetrics} />}

      {isLoading ? (
        <div className="h-[260px] rounded-lg bg-[var(--color-border)] animate-pulse" />
      ) : isError ? (
        <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить данные.</p>
      ) : !hasAnyValue ? (
        <p className="text-sm text-[var(--color-text-muted)] py-8 text-center">
          Нет данных под выбранные фильтры и метрики.
          {mode === 'by-product-groups' && ' Часть метрик (планы, звонки, стадии) считается только по менеджерам.'}
          {mode === 'by-amount-buckets' && ' Часть метрик (планы, звонки, стадии) по корзинам чека не считается.'}
        </p>
      ) : effectiveChartType === 'bar' ? (
        <HBarChart entities={entities} metrics={yMetrics} />
      ) : effectiveChartType === 'line' ? (
        <LineChart entities={entities} metrics={yMetrics} />
      ) : (xMetric && yMetrics[0]) ? (
        <ScatterChart entities={entities} xMetric={xMetric} yMetric={yMetrics[0]} />
      ) : (
        <p className="text-sm text-[var(--color-text-muted)]">Выберите метрики для осей.</p>
      )}

      {mode === 'by-amount-buckets' && (
        <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">
          Корзина — по сумме сделки. Конверсии читаются как «доля сделок этого чека,
          созданных и проданных в выбранном периоде».
        </p>
      )}
      {mode !== 'by-amount-buckets' && effectiveChartType !== 'scatter' && entities.length === TOP_N && (
        <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">Показан топ-{TOP_N} по первой метрике.</p>
      )}
    </section>
  );
}
