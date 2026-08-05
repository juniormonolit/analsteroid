'use client';
// График метрики из отчёта (фича Серёги 01.08): модал поверх отчёта (по образцу
// дрилл-дауна) с линией динамики показателя внутри периода отчёта. Данные —
// /api/reports/metric-series: ТЕ ЖЕ определения метрик (sqlGen) и фильтры
// отчёта, поэтому сумма бакетов collected-метрики сходится со значением ячейки;
// для calculated (проценты/средние) бакеты считаются ФОРМУЛОЙ от сумм бакета,
// а «Итого» — формулой от сумм периода (не суммой точек — проценты не складываются).

import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Download } from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { exportNodeToPng } from '@/features/reports/lib/exportImage';
import type { Metric, DealScope, ClientType, CreatedTimeFilter, FirstTouchFilter, ProductGroupMode } from '@/lib/metrics/types';
import type { DateRange } from '@/lib/period';

export interface MetricChartTarget {
  metricId: string;
  dimensionId: string;
  dimensionName: string;
  /** Ограничение по менеджерам для строки/группы/итога (by-managers); undefined = без него. */
  managerIds?: string[];
  /** Ограничение по товарной группе (строка отчёта by-product-groups). */
  productGroupId?: string;
  /** Значение ячейки отчёта — для сверки «сумма бакетов = ячейка» прямо в модале. */
  cellValue: number | null;
}

type Gran = 'day' | 'week' | 'month';
interface Bucket { bucket: string; value: number | null }
interface SeriesRes { supported: boolean; reason?: string; buckets: Bucket[]; total: number | null }
interface ApiRes { granularity: Gran; current: SeriesRes; comparison: SeriesRes | null }

function autoGran(period: DateRange): Gran {
  const days = (period.to.getTime() - period.from.getTime()) / 86_400_000 + 1;
  if (days <= 45) return 'day';
  if (days <= 200) return 'week';
  return 'month';
}
const GRAN_LABELS: Record<Gran, string> = { day: 'День', week: 'Неделя', month: 'Месяц' };

function fmtVal(v: number | null, m: Metric): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const dp = m.decimalPlaces ?? 0;
  const num = v.toLocaleString('ru-RU', { maximumFractionDigits: dp, minimumFractionDigits: 0 });
  if (m.dataType === 'money') return `${num} ₽`;
  if (m.dataType === 'percent') return `${num}%`;
  return num;
}
function fmtBucketLabel(b: string, gran: Gran): string {
  const [y, m, d] = b.split('-');
  if (gran === 'month') return `${m}.${y.slice(2)}`;
  return `${d}.${m}`;
}
function fmtDateRu(d: Date): string {
  return d.toLocaleDateString('ru-RU');
}

export function MetricChartModal({ target, metric, reportSlug, period, comparison, hasComparison, filters, onClose }: {
  target: MetricChartTarget;
  metric: Metric;
  reportSlug: string;
  period: DateRange;
  comparison: DateRange;
  /** Рисовать ли вторую (сравнительную) линию — включено ли сравнение в отчёте. */
  hasComparison: boolean;
  filters: {
    dealScope: DealScope; clientType: ClientType;
    productGroupMode: ProductGroupMode; productGroupIds?: string[];
    createdTimeFilter: CreatedTimeFilter; firstTouchFilter: FirstTouchFilter;
  };
  onClose: () => void;
}) {
  const [gran, setGran] = useState<Gran>(() => autoGran(period));
  const chartRef = useRef<HTMLDivElement | null>(null);

  const { data, isLoading, isError } = useQuery<ApiRes>({
    queryKey: ['metric-series', target.metricId, target.dimensionId, gran, reportSlug,
      period.from.toISOString(), period.to.toISOString(), hasComparison, JSON.stringify(filters), target.managerIds, target.productGroupId],
    queryFn: async () => {
      const res = await fetch('/api/reports/metric-series', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metricId: target.metricId,
          period: { from: period.from.toISOString(), to: period.to.toISOString() },
          comparisonPeriod: hasComparison ? { from: comparison.from.toISOString(), to: comparison.to.toISOString() } : undefined,
          granularity: gran,
          dealScope: filters.dealScope,
          clientType: filters.clientType,
          managerIds: target.managerIds,
          productGroupMode: filters.productGroupMode,
          productGroupId: target.productGroupId,
          productGroupIds: filters.productGroupIds,
          createdTimeFilter: filters.createdTimeFilter,
          firstTouchFilter: filters.firstTouchFilter,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(() => {
    const cur = data?.current.buckets ?? [];
    const cmp = data?.comparison?.buckets ?? [];
    // Сравнительная линия совмещается ПО ИНДЕКСУ бакета (периоды разной длины —
    // хвост без пары просто без второй линии).
    return cur.map((b, i) => ({
      label: fmtBucketLabel(b.bucket, gran),
      current: b.value,
      comparison: cmp[i]?.value ?? null,
      cmpLabel: cmp[i] ? fmtBucketLabel(cmp[i].bucket, gran) : null,
    }));
  }, [data, gran]);

  const sumBuckets = useMemo(() => {
    const cur = data?.current.buckets ?? [];
    if (cur.length === 0) return null;
    return cur.reduce((s, b) => s + (b.value ?? 0), 0);
  }, [data]);

  const isAdditive = metric.metricType === 'collected';
  const matchesCell = isAdditive && sumBuckets !== null && target.cellValue !== null
    ? Math.abs(sumBuckets - target.cellValue) < 0.51
    : null;

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="hidden sm:block flex-1 min-w-[8%] bg-black/40 cursor-pointer" />
      <div className="w-full sm:w-[860px] sm:max-w-[90vw] shrink-0 bg-[var(--color-bg)] flex flex-col shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-[var(--color-text)] truncate">
              {metric.nameRu} · {target.dimensionName}
            </h2>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              {fmtDateRu(period.from)} — {fmtDateRu(period.to)}
              {hasComparison && <> · сравнение: {fmtDateRu(comparison.from)} — {fmtDateRu(comparison.to)}</>}
            </p>
            <p className="mt-1 text-xs tabular-nums">
              Итого за период: <b>{data ? fmtVal(data.current.total, metric) : '…'}</b>
              {target.cellValue !== null && <span className="ml-2 text-[var(--color-text-muted)]">в ячейке: {fmtVal(target.cellValue, metric)}</span>}
              {matchesCell !== null && (
                <span className="ml-2 font-semibold" style={{ color: matchesCell ? 'var(--color-positive,#2f9e44)' : 'var(--color-negative,#e03131)' }}>
                  {matchesCell ? '✓ сумма точек сходится' : '≠ расходится с ячейкой'}
                </span>
              )}
              {!isAdditive && data?.current.supported && (
                <span className="ml-2 text-[var(--color-text-muted)]" title="Расчётная метрика: каждая точка считается своей формулой от сумм бакета, итог — формулой от сумм периода. Складывать точки нельзя.">
                  расчётная — точки не суммируются
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex rounded-lg border border-[var(--color-border)] overflow-hidden">
              {(['day', 'week', 'month'] as Gran[]).map(g => (
                <button key={g} type="button" onClick={() => setGran(g)}
                  className={`px-2.5 py-1 text-[11px] font-semibold ${gran === g ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                  {GRAN_LABELS[g]}
                </button>
              ))}
            </div>
            <button type="button" title="Скачать PNG"
              onClick={() => { if (chartRef.current) void exportNodeToPng(chartRef.current, `${metric.id}-${target.dimensionId}`); }}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
              <Download size={14} />
            </button>
            <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]" title="Закрыть">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6" ref={chartRef}>
          {isError ? (
            <div className="text-sm text-[var(--color-negative,#e03131)]">Не удалось построить график.</div>
          ) : isLoading ? (
            <div className="text-sm text-[var(--color-text-muted)]">Считаем динамику…</div>
          ) : !data?.current.supported ? (
            <div className="text-sm text-[var(--color-text-muted)]">{data?.current.reason ?? 'Для этой метрики график недоступен.'}</div>
          ) : (
            <div className="h-[420px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis tick={{ fontSize: 11 }} width={70}
                    tickFormatter={(v: number) => Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}М`
                      : Math.abs(v) >= 1_000 ? `${(v / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })}т` : String(v)} />
                  <Tooltip
                    formatter={(v, name) => [fmtVal(typeof v === "number" ? v : null, metric), String(name)]}
                    labelFormatter={(l, payload) => {
                      const p0 = (payload as unknown as { payload?: { cmpLabel?: string | null } }[])?.[0]?.payload;
                      return p0?.cmpLabel ? `${String(l)} (сравн.: ${p0.cmpLabel})` : String(l);
                    }}
                    // Тултип висит над линиями графика — плотная поверхность, не карточная
                    // (регресс #2999: сквозь него читались сами линии).
                    contentStyle={{ background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }} />
                  {hasComparison && data.comparison?.supported && <Legend wrapperStyle={{ fontSize: 12 }} />}
                  <Line type="monotone" dataKey="current" name="Текущий период" stroke="var(--color-accent)" strokeWidth={2}
                    dot={rows.length <= 62} isAnimationActive={false} connectNulls />
                  {hasComparison && data.comparison?.supported && (
                    <Line type="monotone" dataKey="comparison" name="Период сравнения" stroke="var(--color-text-muted)"
                      strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} connectNulls />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
