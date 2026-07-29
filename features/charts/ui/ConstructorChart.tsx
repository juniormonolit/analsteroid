'use client';

import {
  ResponsiveContainer, BarChart, Bar, LineChart as RLineChart, Line,
  ScatterChart as RScatterChart, Scatter, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import type { Metric } from '@/lib/metrics/types';

// Рендеры конструктора графиков — Recharts (решение владельца 29.07: конвенция
// «без chart-либ» снята, нужен интерактив). Принципы прежние:
//  * bar — ГОРИЗОНТАЛЬНЫЕ полосы (имена сущностей длинные), каждая метрика
//    нормируется по СВОЕЙ шкале (скрытая ось на серию) — как в самописной версии;
//  * line — профиль по сущностям (X = сущности, сортировка по первой метрике);
//  * scatter — метрика X × метрика Y, точка = сущность.

export interface ChartEntity {
  id: string;
  name: string;
  values: Array<number | null>; // по одной на Y-метрику
  x?: number | null;            // значение X-метрики (scatter)
}

export const SERIES_COLORS = ['var(--color-accent)', '#0ea5e9', '#10b981', '#f59e0b'];

export function fmtMetricValue(v: number | null, m: Metric | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const dec = m?.decimalPlaces ?? 0;
  if (m?.dataType === 'percent') return `${v.toFixed(dec)}%`;
  return v.toLocaleString('ru-RU', { maximumFractionDigits: dec });
}

export function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн`;
  if (a >= 10_000) return `${Math.round(v / 1000).toLocaleString('ru-RU')} тыс`;
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

export function ChartLegend({ metrics }: { metrics: Metric[] }) {
  if (metrics.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
      {metrics.map((m, i) => (
        <span key={m.id} className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
          {m.nameRu}
        </span>
      ))}
    </div>
  );
}

// Общий тултип: имя сущности + все метрики серии с корректным форматированием.
function EntityTooltip({ active, payload, metrics }: {
  active?: boolean;
  payload?: { payload: Record<string, unknown> }[];
  metrics: Metric[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-lg px-3 py-2 text-xs max-w-[280px]">
      <div className="font-semibold text-[var(--color-text)] mb-1">{String(row.name ?? '')}</div>
      {metrics.map((m, i) => (
        <div key={m.id} className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
          <span className="truncate">{m.nameShortRu || m.nameRu}:</span>
          <b className="text-[var(--color-text)] tabular-nums ml-auto">{fmtMetricValue((row[`v${i}`] as number | null) ?? null, m)}</b>
        </div>
      ))}
    </div>
  );
}

function toRows(entities: ChartEntity[]) {
  return entities.map(e => {
    const row: Record<string, unknown> = { name: e.name, id: e.id };
    e.values.forEach((v, i) => { row[`v${i}`] = v; });
    return row;
  });
}

// ── Горизонтальные полосы ─────────────────────────────────────────────────────
export function HBarChart({ entities, metrics }: { entities: ChartEntity[]; metrics: Metric[] }) {
  const rows = toRows(entities);
  // Высота — по числу сущностей и серий (Recharts требует фиксированную).
  const height = Math.max(200, 24 + entities.length * (metrics.length * 16 + 14));
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, left: 0, bottom: 4 }} barCategoryGap="22%">
          <CartesianGrid horizontal={false} stroke="var(--color-border)" strokeDasharray="3 3" />
          {/* Скрытая ось X на КАЖДУЮ серию — метрики разных порядков (₽ и штуки)
              нормируются каждая по своей шкале, как в прежней самописной версии. */}
          {metrics.map((m, i) => (
            <XAxis key={m.id} xAxisId={i} type="number" hide domain={[0, 'dataMax']} />
          ))}
          <YAxis
            type="category" dataKey="name" width={150}
            tick={{ fontSize: 11, fill: 'var(--color-text)' }}
            axisLine={false} tickLine={false}
            tickFormatter={(v: string) => (v.length > 20 ? `${v.slice(0, 19)}…` : v)}
          />
          <Tooltip content={<EntityTooltip metrics={metrics} />} cursor={{ fill: 'var(--color-bg-hover)', fillOpacity: 0.5 }} />
          {metrics.map((m, i) => (
            <Bar key={m.id} xAxisId={i} dataKey={`v${i}`} fill={SERIES_COLORS[i % SERIES_COLORS.length]} radius={[0, 3, 3, 0]} maxBarSize={16} animationDuration={400} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Профиль-линия по сущностям ────────────────────────────────────────────────
export function LineChart({ entities, metrics }: { entities: ChartEntity[]; metrics: Metric[] }) {
  const rows = toRows(entities);
  return (
    <div className="h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <RLineChart data={rows} margin={{ top: 8, right: 12, left: 8, bottom: 4 }}>
          <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 10, fill: 'var(--color-text-muted)' }}
            tickFormatter={(v: string) => (v.length > 12 ? `${v.slice(0, 11)}…` : v)}
            axisLine={false} tickLine={false}
            interval="preserveStartEnd" minTickGap={16}
          />
          {/* Скрытая ось Y на серию — те же независимые шкалы, что и раньше. */}
          {metrics.map((m, i) => (
            <YAxis key={m.id} yAxisId={i} hide domain={[0, 'dataMax']} />
          ))}
          <Tooltip content={<EntityTooltip metrics={metrics} />} cursor={{ stroke: 'var(--color-border-focus, var(--color-border))', strokeDasharray: '4 4' }} />
          {/* type="linear": по X — сущности (категории), сглаживать между ними нечего */}
          {metrics.map((m, i) => (
            <Line
              key={m.id} yAxisId={i} dataKey={`v${i}`} type="linear"
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeWidth={2}
              dot={{ r: 2.5, strokeWidth: 0, fill: SERIES_COLORS[i % SERIES_COLORS.length] }}
              activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--color-bg-surface)' }}
              connectNulls animationDuration={400}
            />
          ))}
        </RLineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Scatter: метрика × метрика ────────────────────────────────────────────────
function ScatterTooltip({ active, payload, xMetric, yMetric }: {
  active?: boolean;
  payload?: { payload: { name: string; x: number; y: number } }[];
  xMetric: Metric; yMetric: Metric;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-lg px-3 py-2 text-xs max-w-[280px]">
      <div className="font-semibold text-[var(--color-text)] mb-0.5">{p.name}</div>
      <div className="text-[var(--color-text-muted)]">{xMetric.nameShortRu || xMetric.nameRu}: <b className="text-[var(--color-text)]">{fmtMetricValue(p.x, xMetric)}</b></div>
      <div className="text-[var(--color-text-muted)]">{yMetric.nameShortRu || yMetric.nameRu}: <b className="text-[var(--color-text)]">{fmtMetricValue(p.y, yMetric)}</b></div>
    </div>
  );
}

export function ScatterChart({
  entities, xMetric, yMetric,
}: { entities: ChartEntity[]; xMetric: Metric; yMetric: Metric }) {
  const pts = entities
    .filter(e => e.x !== null && e.x !== undefined && e.values[0] !== null)
    .map(e => ({ name: e.name, x: e.x as number, y: e.values[0] as number }));
  return (
    <div>
      <div className="h-[380px]">
        <ResponsiveContainer width="100%" height="100%">
          <RScatterChart margin={{ top: 8, right: 16, left: 4, bottom: 8 }}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
            <XAxis
              type="number" dataKey="x" domain={[0, 'dataMax']}
              tickFormatter={fmtCompact}
              tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
              axisLine={false} tickLine={false}
            />
            <YAxis
              type="number" dataKey="y" domain={[0, 'dataMax']}
              tickFormatter={fmtCompact}
              tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
              axisLine={false} tickLine={false}
              width={52}
            />
            <Tooltip content={<ScatterTooltip xMetric={xMetric} yMetric={yMetric} />} cursor={{ strokeDasharray: '4 4', stroke: 'var(--color-border-focus, var(--color-border))' }} />
            <Scatter data={pts} fill="var(--color-accent)" fillOpacity={0.65} animationDuration={400} />
          </RScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-0.5 text-center text-[10px] text-[var(--color-text-muted)]">
        по горизонтали — {xMetric.nameRu}; по вертикали — {yMetric.nameRu}
      </div>
    </div>
  );
}
