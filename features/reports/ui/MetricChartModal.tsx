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
  ReferenceArea, ReferenceLine,
} from 'recharts';
import { exportNodeToPng } from '@/features/reports/lib/exportImage';
import type { Metric, DealScope, ClientType, CreatedTimeFilter, FirstTouchFilter, ProductGroupMode } from '@/lib/metrics/types';
import type { DealFilter } from '@/lib/metrics/dealFilters';
import { previousPeriodSameLength, type DateRange } from '@/lib/period';

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
interface SeriesRes { supported: boolean; reason?: string; buckets: Bucket[]; cumulativeBuckets?: Bucket[]; total: number | null }
interface ApiRes { granularity: Gran; current: SeriesRes; comparison: SeriesRes | null; previous: SeriesRes | null }

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
    /** «Фильтр сделок» отчёта — график обязан считаться по тому же срезу, что ячейка. */
    dealFilters?: DealFilter[];
  };
  onClose: () => void;
}) {
  const [gran, setGran] = useState<Gran>(() => autoGran(period));
  // «С накоплением» и «Линия тренда» (правка владельца 24.08). Накопление
  // приходит с сервера отдельной серией в том же ответе (cumulativeBuckets):
  // для расчётных метрик это формула от накопленных сумм зависимостей, а не
  // сумма точек — проценты складывать нельзя. Тумблеры не перезапрашивают данные.
  const [cumulative, setCumulative] = useState(false);
  const [showTrend, setShowTrend] = useState(false);
  const chartRef = useRef<HTMLDivElement | null>(null);

  // Третья линия — период, НЕПОСРЕДСТВЕННО предшествующий текущему (правка
  // владельца 25.08: «и период сравнения, и предыдущий — прям на одном
  // графике»). Тот же хелпер, что у дефолта карточки менеджера. Если период
  // сравнения отчёта и есть предыдущий (совпал день в день) — третью линию не
  // рисуем: две одинаковые линии друг на друге читались бы как баг.
  const prevRange = useMemo(() => previousPeriodSameLength(period), [period]);
  const prevIsComparison = hasComparison
    && prevRange.from.toDateString() === comparison.from.toDateString()
    && prevRange.to.toDateString() === comparison.to.toDateString();
  // Наложенную линию сравнения рисуем только когда её дни НЕ лежат на полотне
  // (полотно = [пред.from, тек.to]). Живой баг со скрина владельца 25.08: период
  // сравнения «весь июль» и предыдущий «28 дней июля» почти совпадали — июльские
  // данные рисовались дважды, отрезком слева и пунктиром поверх августа. Точного
  // совпадения дат мало: любое пересечение с полотном = дубль данных.
  const cmpOnCanvas = hasComparison
    && comparison.to.getTime() >= prevRange.from.getTime()
    && comparison.from.getTime() <= period.to.getTime();
  const showCmpOverlay = hasComparison && !prevIsComparison && !cmpOnCanvas;

  const { data, isLoading, isError } = useQuery<ApiRes>({
    queryKey: ['metric-series', target.metricId, target.dimensionId, gran, reportSlug,
      period.from.toISOString(), period.to.toISOString(), hasComparison, prevIsComparison, showCmpOverlay, JSON.stringify(filters), target.managerIds, target.productGroupId],
    queryFn: async () => {
      const res = await fetch('/api/reports/metric-series', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metricId: target.metricId,
          period: { from: period.from.toISOString(), to: period.to.toISOString() },
          comparisonPeriod: (prevIsComparison || showCmpOverlay) ? { from: comparison.from.toISOString(), to: comparison.to.toISOString() } : undefined,
          previousPeriod: prevIsComparison ? undefined : { from: prevRange.from.toISOString(), to: prevRange.to.toISOString() },
          granularity: gran,
          dealScope: filters.dealScope,
          clientType: filters.clientType,
          managerIds: target.managerIds,
          productGroupMode: filters.productGroupMode,
          productGroupId: target.productGroupId,
          productGroupIds: filters.productGroupIds,
          createdTimeFilter: filters.createdTimeFilter,
          firstTouchFilter: filters.firstTouchFilter,
          dealFilters: filters.dealFilters?.length ? filters.dealFilters : undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(() => {
    const pick = (r: SeriesRes | null | undefined): Bucket[] =>
      (cumulative ? r?.cumulativeBuckets ?? r?.buckets : r?.buckets) ?? [];
    const cur = pick(data?.current);
    const cmp = pick(data?.comparison);
    // Предыдущий период — СЛЕВА на той же оси времени, перетекает в текущий
    // (правка владельца 25.08: «пусть предыдущий график переходит в текущий, а
    // не накладывается сверху»). Обе половины — ОДНА серия value: линия
    // непрерывна через стык. Если период сравнения отчёта и есть предыдущий
    // (prevIsComparison), левым отрезком служит серия сравнения — данные те же,
    // второй раз не запрашиваем.
    const prev = prevIsComparison ? cmp : pick(data?.previous);
    const overlayCmp = showCmpOverlay ? cmp : [];

    const prevRows = prev.map(b => ({
      label: fmtBucketLabel(b.bucket, gran),
      value: b.value,
      comparison: null as number | null,
      cmpLabel: null as string | null,
      isPrev: true,
      trendPrev: null as number | null,
      trendCur: null as number | null,
    }));
    const curRows = cur.map((b, i) => ({
      label: fmtBucketLabel(b.bucket, gran),
      value: b.value,
      // Наложенное сравнение осталось только для НЕсоседнего периода сравнения:
      // совмещается по индексу бакета текущего отрезка, как раньше.
      comparison: overlayCmp[i]?.value ?? null,
      cmpLabel: overlayCmp[i] ? fmtBucketLabel(overlayCmp[i].bucket, gran) : null,
      isPrev: false,
      trendPrev: null as number | null,
      trendCur: null as number | null,
    }));
    // Уникальный x на каждую точку: на стыке недельных/месячных бакетов ярлык
    // может ПОВТОРИТЬСЯ (неделя 27.07 есть и у предыдущего периода, и у
    // текущего) — категорийная ось по label якорила подложку и линию стыка по
    // ПЕРВОМУ совпадению, и они съезжали (скрин владельца 25.08).
    const out = [...prevRows, ...curRows].map((r, i) => ({ ...r, x: String(i) }));

    // Тренды — ДВА, по одному на каждый отрезок (правка владельца там же):
    // МНК по видимым значениям внутри своего отрезка, между первой и последней
    // точками с данными (экстраполяция в незавершённый хвост — это прогноз,
    // которым линия не является).
    if (showTrend) {
      const fit = (from: number, to: number, key: 'trendPrev' | 'trendCur') => {
        const pts: [number, number][] = [];
        for (let i = from; i < to; i++) if (out[i].value !== null) pts.push([i, out[i].value as number]);
        if (pts.length < 2) return;
        const n = pts.length;
        const sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
        const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0), sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
        const d = n * sxx - sx * sx;
        if (d === 0) return;
        const slope = (n * sxy - sx * sy) / d, intercept = (sy - slope * sx) / n;
        for (let i = pts[0][0]; i <= pts[n - 1][0]; i++) out[i][key] = intercept + slope * i;
      };
      fit(0, prevRows.length, 'trendPrev');
      fit(prevRows.length, out.length, 'trendCur');
    }
    return out;
  }, [data, gran, cumulative, showTrend, showCmpOverlay, prevIsComparison]);

  // Индекс первого бакета текущего периода — для фона и линии стыка.
  const prevLen = useMemo(() => {
    const pick = (r: SeriesRes | null | undefined): Bucket[] => r?.buckets ?? [];
    return (prevIsComparison ? pick(data?.comparison) : pick(data?.previous)).length;
  }, [data, prevIsComparison]);

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
      <div className="w-full sm:w-[1100px] sm:max-w-[94vw] shrink-0 bg-[var(--color-bg)] flex flex-col shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-[var(--color-text)] truncate">
              {metric.nameRu} · {target.dimensionName}
            </h2>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              {fmtDateRu(period.from)} — {fmtDateRu(period.to)}
              {hasComparison && <> · сравнение: {fmtDateRu(comparison.from)} — {fmtDateRu(comparison.to)}{cmpOnCanvas && !prevIsComparison ? ' (эти дни уже на полотне)' : ''}</>}
              {!prevIsComparison && <> · пред.: {fmtDateRu(prevRange.from)} — {fmtDateRu(prevRange.to)}</>}
            </p>
            <p className="mt-1 text-xs tabular-nums">
              Итого за период: <b>{data ? fmtVal(data.current.total, metric) : '…'}</b>
              {target.cellValue !== null && <span className="ml-2 text-[var(--color-text-muted)]">в ячейке: {fmtVal(target.cellValue, metric)}</span>}
              {matchesCell !== null && !cumulative && (
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

        {/* Тумблеры вида (правка владельца 24.08) — отдельным рядом под шапкой:
            в шапку на 375px уже не влезает, а flex-wrap здесь безопасен. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 sm:px-6 py-2 shrink-0">
          <button type="button" onClick={() => setCumulative(v => !v)}
            title="Каждая точка — значение с начала периода по этот день. Для процентов накапливаются числитель и знаменатель, а не сами проценты."
            className={`tap-target min-h-8 rounded-full border px-3 text-[11px] font-semibold transition-colors ${
              cumulative ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
            С накоплением
          </button>
          <button type="button" onClick={() => setShowTrend(v => !v)}
            title="Две прямые по методу наименьших квадратов — отдельно для предыдущего и текущего отрезков: видно, как сменился наклон"
            className={`tap-target min-h-8 rounded-full border px-3 text-[11px] font-semibold transition-colors ${
              showTrend ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
            Линия тренда
          </button>
          {cumulative && (
            <span className="text-[11px] text-[var(--color-text-muted)]">
              точка = значение с начала периода по этот {gran === 'day' ? 'день' : gran === 'week' ? 'неделю' : 'месяц'} включительно
            </span>
          )}
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
                  <XAxis dataKey="x" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={16}
                    tickFormatter={(v: string) => rows[Number(v)]?.label ?? ''} />
                  <YAxis tick={{ fontSize: 11 }} width={70}
                    tickFormatter={(v: number) => Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}М`
                      : Math.abs(v) >= 1_000 ? `${(v / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })}т` : String(v)} />
                  <Tooltip
                    formatter={(v, name) => [fmtVal(typeof v === "number" ? v : null, metric), String(name)]}
                    labelFormatter={(_l, payload) => {
                      const p0 = (payload as unknown as { payload?: { label?: string; cmpLabel?: string | null; isPrev?: boolean } }[])?.[0]?.payload;
                      const parts = [p0?.label ?? ''];
                      if (p0?.isPrev) parts.push('предыдущий период');
                      if (p0?.cmpLabel) parts.push(`сравн.: ${p0.cmpLabel}`);
                      return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(' · ')})` : parts[0];
                    }}
                    // Тултип висит над линиями графика — плотная поверхность, не карточная
                    // (регресс #2999: сквозь него читались сами линии).
                    contentStyle={{ background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }} />
                  {(showTrend || (showCmpOverlay && data.comparison?.supported) || prevLen > 0) && <Legend wrapperStyle={{ fontSize: 12 }} />}
                  {/* Предыдущий период — фоном слева + линия стыка: одна серия value
                      непрерывно перетекает из отрезка в отрезок (правка владельца
                      25.08 №2), а где кончился предыдущий и начался текущий, видно
                      по подложке, не по разрыву линии. */}
                  {prevLen > 0 && rows.length > prevLen && (
                    <ReferenceArea x1={rows[0].x} x2={rows[prevLen - 1].x}
                      fill="var(--color-text-muted)" fillOpacity={0.07} ifOverflow="extendDomain" />
                  )}
                  {prevLen > 0 && rows.length > prevLen && (
                    <ReferenceLine x={rows[prevLen].x} stroke="var(--color-border-strong, var(--color-border))"
                      strokeDasharray="4 3"
                      label={{ value: 'текущий период →', position: 'insideTopLeft', fontSize: 10, fill: 'var(--color-text-muted)' }} />
                  )}
                  <Line type="monotone" dataKey="value" name="Значение" stroke="var(--color-accent)" strokeWidth={2}
                    dot={rows.length <= 62} isAnimationActive={false} connectNulls />
                  {showCmpOverlay && data.comparison?.supported && (
                    <Line type="monotone" dataKey="comparison" name="Период сравнения (наложен)" stroke="var(--color-text-muted)"
                      strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} connectNulls />
                  )}
                  {showTrend && (
                    // linear, не monotone: тренд — прямая по определению. Трендов ДВА,
                    // по одному на отрезок — видно, как сменился наклон между периодами.
                    <Line type="linear" dataKey="trendPrev" name="Тренд (пред.)" stroke="var(--color-warning, #e8590c)"
                      strokeOpacity={0.45} strokeWidth={1.5} strokeDasharray="2 4" dot={false} isAnimationActive={false} connectNulls
                      activeDot={false} />
                  )}
                  {showTrend && (
                    <Line type="linear" dataKey="trendCur" name="Тренд (тек.)" stroke="var(--color-warning, #e8590c)"
                      strokeWidth={1.5} strokeDasharray="2 4" dot={false} isAnimationActive={false} connectNulls
                      activeDot={false} />
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
