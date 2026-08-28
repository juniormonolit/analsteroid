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

/** Разница между точками: для процентных метрик — п.п., иначе абсолют + %. */
function fmtDelta(cur: number | null, base: number | null, m: Metric): string | null {
  if (cur === null || base === null) return null;
  const d = cur - base;
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  const abs = Math.abs(d);
  if (m.dataType === 'percent') {
    return `${sign}${abs.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} п.п.`;
  }
  const rel = base !== 0
    ? ` (${sign}${Math.abs((d / base) * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%)`
    : '';
  return `${sign}${fmtVal(abs, m)}${rel}`;
}

interface ChartRow {
  label: string; value: number | null;
  previous: number | null; prevLabel: string | null;
  comparison: number | null; cmpLabel: string | null;
  isPrev: boolean;
}

/** Тултип с разницей между периодами (правка владельца 25.08: «навожусь на июль
 *  и сразу вижу этот год, тот год и рост/падение»). Свой компонент вместо
 *  formatter: стандартный рендерит строки по сериям и не умеет строку-дельту. */
function DeltaTooltip({ active, payload, metric }: {
  active?: boolean;
  payload?: { payload?: ChartRow }[];
  metric: Metric;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const dPrev = fmtDelta(row.value, row.previous, metric);
  const dCmp = fmtDelta(row.value, row.comparison, metric);
  return (
    <div style={{ background: 'var(--color-bg-overlay)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12, padding: '8px 10px' }}>
      <div className="font-semibold text-[var(--color-text)]">
        {row.label}{row.isPrev ? ' · предыдущий период' : ''}
      </div>
      {row.value !== null && (
        <div className="mt-1 tabular-nums" style={{ color: 'var(--color-accent)' }}>
          {row.isPrev ? 'Значение' : 'Текущий'}: <b>{fmtVal(row.value, metric)}</b>
        </div>
      )}
      {row.previous !== null && (
        <div className="tabular-nums" style={{ color: 'var(--color-positive, #2f9e44)' }}>
          Пред. ({row.prevLabel}): <b>{fmtVal(row.previous, metric)}</b>
        </div>
      )}
      {row.comparison !== null && (
        <div className="tabular-nums text-[var(--color-text-muted)]">
          Сравн. ({row.cmpLabel}): <b>{fmtVal(row.comparison, metric)}</b>
        </div>
      )}
      {dPrev && <div className="mt-1 tabular-nums text-[var(--color-text)]">к пред.: <b>{dPrev}</b></div>}
      {dCmp && <div className="tabular-nums text-[var(--color-text)]">к сравн.: <b>{dCmp}</b></div>}
    </div>
  );
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
    /** Фильтр отчёта по отделам — график обязан считаться по тому же срезу. */
    departmentIds?: string[];
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
  // Режим компоновки (правка владельца 25.08 №5): «Последовательно» — предыдущий
  // период перетекает в текущий на общей оси; «С наложением» — периоды друг под
  // другом на оси ТЕКУЩЕГО периода, наведение на дату показывает обе точки и
  // разницу (кейс владельца: «строю выручку помесячно, навожусь на июль и сразу
  // вижу этот год, тот год и рост/падение»).
  const [layout, setLayout] = useState<'seq' | 'overlay'>('seq');
  const chartRef = useRef<HTMLDivElement | null>(null);

  // Полотно графика — предыдущий период + текущий (правка владельца 25.08:
  // «предыдущий переходит в текущий»). Предыдущий — НЕПОСРЕДСТВЕННО
  // предшествующий той же длины (хелпер дефолта карточки менеджера).
  //
  // Полотно считается ОДНИМ запросом за весь диапазон [пред.from, тек.to], а не
  // склейкой двух серий (правка владельца 25.08 №3, скрин с «ямой»): при
  // недельных/месячных бакетах граница периодов режет стыковый бакет на два
  // ОГРЫЗКА — хвост у предыдущего (27–31.07) и голову у текущего (01–02.08),
  // оба неполные, на графике одна и та же неделя стояла двумя точками с ямой
  // между ними. Единый запрос даёт стыковому бакету одно полное значение —
  // артефакту неоткуда взяться, включая формулы расчётных метрик.
  const prevRange = useMemo(() => previousPeriodSameLength(period), [period]);
  // Наложенную линию сравнения рисуем только когда её дни НЕ лежат на полотне:
  // период сравнения «весь июль» при предыдущем «28 дней июля» рисовался дважды
  // (скрин владельца 25.08) — любое пересечение с полотном означает дубль данных.
  const cmpOnCanvas = hasComparison
    && comparison.to.getTime() >= prevRange.from.getTime()
    && comparison.from.getTime() <= period.to.getTime();
  // Наложение — ДВЕ линии, не три (правка владельца 27.08: «зачем три линии?
  // ограничься двумя»): текущий период + одна базовая. Базовая — период
  // сравнения отчёта, а без включённого сравнения — предыдущий период.
  const baseIsCmp = layout === 'overlay' && hasComparison;
  // В последовательном режиме наложенное сравнение рисуем только когда его дни
  // не лежат на полотне (иначе дубль данных — скрин владельца 25.08).
  const showCmpOverlay = layout === 'overlay' ? baseIsCmp : hasComparison && !cmpOnCanvas;

  const { data, isLoading, isError } = useQuery<ApiRes>({
    queryKey: ['metric-series', target.metricId, target.dimensionId, gran, reportSlug,
      period.from.toISOString(), period.to.toISOString(), hasComparison, showCmpOverlay, layout, JSON.stringify(filters), target.managerIds, target.productGroupId],
    queryFn: async () => {
      const res = await fetch('/api/reports/metric-series', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metricId: target.metricId,
          period: { from: period.from.toISOString(), to: period.to.toISOString() },
          comparisonPeriod: showCmpOverlay ? { from: comparison.from.toISOString(), to: comparison.to.toISOString() } : undefined,
          // Последовательно: «previous» = серия ПОЛОТНА целиком (пред.from…тек.to),
          // стыковый бакет — одна полная точка. Наложение: предыдущий период
          // нужен только когда он и есть базовая линия (сравнение выключено).
          previousPeriod: layout === 'seq'
            ? { from: prevRange.from.toISOString(), to: period.to.toISOString() }
            : baseIsCmp ? undefined : { from: prevRange.from.toISOString(), to: prevRange.to.toISOString() },
          departmentIds: filters.departmentIds?.length ? filters.departmentIds : undefined,
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

  const chart = useMemo(() => {
    const pick = (r: SeriesRes | null | undefined): Bucket[] =>
      (cumulative ? r?.cumulativeBuckets ?? r?.buckets : r?.buckets) ?? [];
    // МНК-прямая по точкам [from, to) исходного ключа src → в ключ dst.
    const fitKey = (
      out: Record<string, number | string | null | boolean>[],
      from: number, to: number, src: string, dst: string,
    ) => {
      const pts: [number, number][] = [];
      for (let i = from; i < to; i++) if (out[i][src] !== null) pts.push([i, out[i][src] as number]);
      if (pts.length < 2) return;
      const n = pts.length;
      const sx = pts.reduce((a, q) => a + q[0], 0), sy = pts.reduce((a, q) => a + q[1], 0);
      const sxx = pts.reduce((a, q) => a + q[0] * q[0], 0), sxy = pts.reduce((a, q) => a + q[0] * q[1], 0);
      const d = n * sxx - sx * sx;
      if (d === 0) return;
      const slope = (n * sxy - sx * sy) / d, intercept = (sy - slope * sx) / n;
      for (let i = pts[0][0]; i <= pts[n - 1][0]; i++) out[i][dst] = intercept + slope * i;
    };

    if (layout === 'overlay') {
      // ДВЕ линии: текущий период + базовая (сравнение отчёта, иначе предыдущий).
      const cur = pick(data?.current);
      const base = baseIsCmp ? pick(data?.comparison) : pick(data?.previous);
      const baseFrom = baseIsCmp ? comparison.from : prevRange.from;

      // Выравнивание (правка владельца 27.08: «подгоняй 25 число к 25 числу, и
      // пусть хвосты висят»). Дни: дата базовой линии сдвигается на целое число
      // МЕСЯЦЕВ между стартами периодов — 25.07 к 25.08, 25.07.25 к 25.07.26.
      // Числа, которых нет в целевом месяце (31-е к февралю), честно выпадают.
      // Недели/месяцы уже выровнены календарём — там совмещение по индексу.
      // Если совпало меньше половины точек (периоды внутри одного месяца:
      // прошлая неделя против этой), откатываемся на совмещение по индексу.
      const shiftMonths = (period.from.getFullYear() - baseFrom.getFullYear()) * 12
        + (period.from.getMonth() - baseFrom.getMonth());
      const mapKey = (bucket: string): string | null => {
        if (gran !== 'day') return null;
        const [y, m, d] = bucket.split('-').map(Number);
        const t = new Date(Date.UTC(y, m - 1 + shiftMonths, d));
        return t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
      };

      let mapped: { key: string; value: number | null; label: string }[] = [];
      if (gran === 'day') {
        mapped = base.flatMap(b => {
          const key = mapKey(b.bucket);
          return key ? [{ key, value: b.value, label: fmtBucketLabel(b.bucket, gran) }] : [];
        });
        const curKeys = new Set(cur.map(b => b.bucket));
        const matches = mapped.filter(mb => curKeys.has(mb.key)).length;
        if (matches < Math.min(cur.length, base.length) / 2) mapped = [];
      }
      if (mapped.length === 0) {
        // по индексу: i-й бакет к i-му (недели/месяцы, либо фолбэк для дней)
        mapped = base.map((b, i) => ({
          key: cur[i]?.bucket ?? `~tail${i}`,
          value: b.value,
          label: fmtBucketLabel(b.bucket, gran),
        }));
      }
      const baseByKey = new Map(mapped.map(mb => [mb.key, mb]));

      // Ось = бакеты текущего периода + висящие хвосты базовой линии.
      const tailKeys = mapped.map(mb => mb.key).filter(k => !cur.some(b => b.bucket === k));
      const axis: { key: string; curValue: number | null }[] = [
        ...cur.map(b => ({ key: b.bucket, curValue: b.value })),
        ...tailKeys.map(k => ({ key: k, curValue: null })),
      ].sort((a, b) => a.key.localeCompare(b.key));

      const out = axis.map((a, i) => {
        const mb = baseByKey.get(a.key);
        return {
          x: String(i),
          label: a.key.startsWith('~tail') ? (mb?.label ?? '') : fmtBucketLabel(a.key, gran),
          value: a.curValue,
          previous: !baseIsCmp ? mb?.value ?? null : null,
          prevLabel: !baseIsCmp ? mb?.label ?? null : null,
          comparison: baseIsCmp ? mb?.value ?? null : null,
          cmpLabel: baseIsCmp ? mb?.label ?? null : null,
          isPrev: false,
          trendPrev: null as number | null,
          trendCur: null as number | null,
        };
      });
      if (showTrend) {
        fitKey(out, 0, out.length, 'value', 'trendCur');
        fitKey(out, 0, out.length, baseIsCmp ? 'comparison' : 'previous', 'trendPrev');
      }
      return { rows: out, seam: 0 };
    }
    // Полотно — union-серия (data.previous, запрошена за пред.from…тек.to одним
    // куском): стыковый недельный/месячный бакет — ОДНА полная точка, а не два
    // огрызка по границе периодов (скрин владельца 25.08 с «ямой»). Фолбэк на
    // серию текущего периода — если union не пришла (старый кэш, сбой запроса).
    const canvas = data?.previous?.supported ? pick(data.previous) : pick(data?.current);
    // Шов: первый бакет, начавшийся не раньше старта текущего периода. Стыковый
    // бакет, начавшийся в предыдущем периоде и захвативший начало текущего,
    // остаётся в затенённой зоне — он начался там.
    const fromYmd = period.from.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
    let seam = data?.previous?.supported ? canvas.findIndex(b => b.bucket >= fromYmd) : 0;
    if (seam < 0) seam = 0;

    // Наложенное сравнение совмещается с бакетами ТЕКУЩЕГО периода по КЛЮЧУ
    // бакета: полотно длиннее серии текущего периода, индексы не годятся.
    const cmp = showCmpOverlay ? pick(data?.comparison) : [];
    const curBuckets = pick(data?.current);
    const overlayByBucket = new Map<string, { value: number | null; label: string }>();
    curBuckets.forEach((b, i) => {
      if (cmp[i]) overlayByBucket.set(b.bucket, { value: cmp[i].value, label: fmtBucketLabel(cmp[i].bucket, gran) });
    });

    const out = canvas.map((b, i) => {
      const ov = overlayByBucket.get(b.bucket);
      return {
        // Уникальный x на точку: ярлыки бакетов на полотне могут повторяться,
        // категорийная ось по label якорила подложку/шов по первому совпадению.
        x: String(i),
        label: fmtBucketLabel(b.bucket, gran),
        value: b.value,
        previous: null as number | null,
        prevLabel: null as string | null,
        comparison: ov?.value ?? null,
        cmpLabel: ov?.label ?? null,
        isPrev: i < seam,
        trendPrev: null as number | null,
        trendCur: null as number | null,
      };
    });

    // Тренды — ДВА, по одному на отрезок: МНК по видимым значениям между первой
    // и последней точками с данными своего отрезка (экстраполяция в
    // незавершённый хвост — это прогноз, которым линия не является).
    if (showTrend) {
      fitKey(out, 0, seam, 'value', 'trendPrev');
      fitKey(out, seam, out.length, 'value', 'trendCur');
    }
    return { rows: out, seam };
  }, [data, gran, cumulative, showTrend, showCmpOverlay, period, layout]);
  const rows = chart.rows;
  const seam = chart.seam;

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
              {hasComparison && <> · сравнение: {fmtDateRu(comparison.from)} — {fmtDateRu(comparison.to)}{layout === 'seq' && cmpOnCanvas ? ' (эти дни уже на полотне)' : ''}</>}
              <> · пред.: {fmtDateRu(prevRange.from)} — {fmtDateRu(prevRange.to)}</>
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
          <div className="flex overflow-hidden rounded-full border border-[var(--color-border)]">
            {([['seq', 'Последовательно'], ['overlay', 'С наложением']] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setLayout(k)}
                title={k === 'seq'
                  ? 'Предыдущий период слева, перетекает в текущий на общей оси времени'
                  : 'Периоды друг под другом: наведи на дату — видно обе точки и разницу'}
                className={`tap-target min-h-8 px-3 text-[11px] font-semibold transition-colors ${
                  layout === k ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setCumulative(v => !v)}
            title="Каждая точка — накопление с НАЧАЛА ПОЛОТНА (предыдущий период + текущий). Для процентов накапливаются числитель и знаменатель, а не сами проценты."
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
              {layout === 'seq'
                ? 'накопление с начала полотна (включая предыдущий период)'
                : 'каждая линия копит с начала СВОЕГО периода'}
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
                  {/* Свой контент: строки значений + разница между периодами.
                      Плотная поверхность, не карточная (регресс #2999). */}
                  <Tooltip content={<DeltaTooltip metric={metric} />} />
                  {(layout === 'overlay' || showTrend || (showCmpOverlay && data.comparison?.supported) || seam > 0) && <Legend wrapperStyle={{ fontSize: 12 }} />}
                  {/* Предыдущий период — фоном слева + линия стыка: одна серия value
                      непрерывно перетекает из отрезка в отрезок (правка владельца
                      25.08 №2), а где кончился предыдущий и начался текущий, видно
                      по подложке, не по разрыву линии. */}
                  {layout === 'seq' && seam > 0 && rows.length > seam && (
                    <ReferenceArea x1={rows[0].x} x2={rows[seam - 1].x}
                      fill="var(--color-text-muted)" fillOpacity={0.07} ifOverflow="extendDomain" />
                  )}
                  {layout === 'seq' && seam > 0 && rows.length > seam && (
                    <ReferenceLine x={rows[seam].x} stroke="var(--color-border-strong, var(--color-border))"
                      strokeDasharray="4 3"
                      label={{ value: 'текущий период →', position: 'insideTopLeft', fontSize: 10, fill: 'var(--color-text-muted)' }} />
                  )}
                  <Line type="monotone" dataKey="value" name={layout === 'overlay' ? 'Текущий период' : 'Значение'} stroke="var(--color-accent)" strokeWidth={2}
                    dot={rows.length <= 62} isAnimationActive={false} connectNulls />
                  {layout === 'overlay' && data.previous?.supported && (
                    <Line type="monotone" dataKey="previous" name="Предыдущий период" stroke="var(--color-positive, #2f9e44)"
                      strokeWidth={1.5} strokeDasharray="2 3" dot={false} isAnimationActive={false} connectNulls />
                  )}
                  {showCmpOverlay && data.comparison?.supported && (
                    <Line type="monotone" dataKey="comparison" name={layout === 'overlay' ? 'Период сравнения' : 'Период сравнения (наложен)'} stroke="var(--color-text-muted)"
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
