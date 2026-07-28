'use client';

import { useState } from 'react';
import type { Metric } from '@/lib/metrics/types';

// Рендеры конструктора графиков. Самописные (конвенция проекта — без chart-либ):
//  * bar — ГОРИЗОНТАЛЬНЫЕ полосы (имена сущностей длинные, на 375px вертикальные
//    столбики с подписями нечитаемы; горизонтальный список скроллится естественно);
//  * line — профиль по сущностям (X = сущности, отсортированы по первой метрике);
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

// ── Горизонтальные полосы ─────────────────────────────────────────────────────
export function HBarChart({ entities, metrics }: { entities: ChartEntity[]; metrics: Metric[] }) {
  const maxBySeries = metrics.map((_, si) =>
    Math.max(1e-9, ...entities.map(e => Math.abs(e.values[si] ?? 0))),
  );
  return (
    <div className="space-y-2">
      {entities.map(e => (
        <div key={e.id} className="flex items-center gap-2 sm:gap-3">
          <div className="w-28 sm:w-44 shrink-0 text-xs text-[var(--color-text)] truncate" title={e.name}>{e.name}</div>
          <div className="flex-1 min-w-0 space-y-0.5">
            {metrics.map((m, si) => {
              const v = e.values[si];
              const w = v === null ? 0 : Math.max(0.5, (Math.abs(v) / maxBySeries[si]) * 100);
              return (
                <div key={m.id} className="flex items-center gap-1.5">
                  <div className="flex-1 min-w-0 h-3.5 rounded-sm bg-[var(--color-bg)] overflow-hidden">
                    <div
                      className="h-full rounded-sm"
                      style={{ width: `${w}%`, background: SERIES_COLORS[si % SERIES_COLORS.length], opacity: v === null ? 0 : 0.9 }}
                    />
                  </div>
                  <div className="w-16 sm:w-20 shrink-0 text-right text-[10px] tabular-nums text-[var(--color-text-muted)]">
                    {v === null ? '—' : fmtCompact(v)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Профиль-линия по сущностям ────────────────────────────────────────────────
const LW = 720;
const LH = 260;
const L_PAD = { t: 14, b: 6, x: 8 };

export function LineChart({ entities, metrics }: { entities: ChartEntity[]; metrics: Metric[] }) {
  const [sel, setSel] = useState<number | null>(null);
  const innerW = LW - L_PAD.x * 2;
  const innerH = LH - L_PAD.t - L_PAD.b;
  const n = entities.length;
  const maxBySeries = metrics.map((_, si) => Math.max(1e-9, ...entities.map(e => e.values[si] ?? 0)));

  const xAt = (i: number) => L_PAD.x + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
  const selected = sel !== null ? entities[sel] : null;
  const labelEvery = Math.max(1, Math.ceil(n / 8));

  return (
    <div>
      <div className="h-5 mb-1 text-xs text-[var(--color-text-muted)] truncate">
        {selected ? (
          <span>
            <b className="text-[var(--color-text)]">{selected.name}</b>
            {metrics.map((m, si) => ` · ${m.nameShortRu || m.nameRu}: ${fmtMetricValue(selected.values[si], m)}`).join('')}
          </span>
        ) : (
          <span>Нажмите на точку, чтобы увидеть цифры</span>
        )}
      </div>
      <svg viewBox={`0 0 ${LW} ${LH}`} width="100%" height={LH} preserveAspectRatio="none" className="block select-none">
        {[0.25, 0.5, 0.75, 1].map(t => (
          <line key={t} x1={L_PAD.x} x2={LW - L_PAD.x} y1={L_PAD.t + (1 - t) * innerH} y2={L_PAD.t + (1 - t) * innerH}
            stroke="var(--color-border)" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        ))}
        {metrics.map((m, si) => {
          const pts = entities
            .map((e, i) => ({ i, v: e.values[si] }))
            .filter((p): p is { i: number; v: number } => p.v !== null)
            .map(p => ({ x: xAt(p.i), y: L_PAD.t + (1 - p.v / maxBySeries[si]) * innerH }));
          if (pts.length === 0) return null;
          const path = pts.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
          return (
            <g key={m.id}>
              <path d={path} fill="none" stroke={SERIES_COLORS[si % SERIES_COLORS.length]} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              {pts.map((p, j) => <circle key={j} cx={p.x} cy={p.y} r={2.5} fill={SERIES_COLORS[si % SERIES_COLORS.length]} />)}
            </g>
          );
        })}
        {entities.map((_, i) => (
          <rect key={i} x={xAt(i) - (innerW / Math.max(1, n - 1)) / 2} y={0} width={innerW / Math.max(1, n - 1)} height={LH}
            fill="transparent" className="cursor-pointer" onClick={() => setSel(sel === i ? null : i)} />
        ))}
        {sel !== null && (
          <line x1={xAt(sel)} x2={xAt(sel)} y1={L_PAD.t} y2={L_PAD.t + innerH} stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="flex justify-between mt-1 text-[9px] sm:text-[10px] text-[var(--color-text-muted)]">
        {entities.filter((_, i) => i % labelEvery === 0).map(e => (
          <span key={e.id} className="truncate max-w-16 sm:max-w-24">{e.name}</span>
        ))}
      </div>
    </div>
  );
}

// ── Scatter: метрика × метрика ────────────────────────────────────────────────
const SW = 720;
const SH = 380;
const S_PAD = { t: 12, r: 14, b: 26, l: 52 };

export function ScatterChart({
  entities, xMetric, yMetric,
}: { entities: ChartEntity[]; xMetric: Metric; yMetric: Metric }) {
  const [sel, setSel] = useState<string | null>(null);
  const pts = entities.filter(e => e.x !== null && e.x !== undefined && e.values[0] !== null);
  const maxX = Math.max(1e-9, ...pts.map(e => e.x as number));
  const maxY = Math.max(1e-9, ...pts.map(e => e.values[0] as number));
  const innerW = SW - S_PAD.l - S_PAD.r;
  const innerH = SH - S_PAD.t - S_PAD.b;

  const selected = pts.find(e => e.id === sel) ?? null;

  return (
    <div>
      <div className="h-5 mb-1 text-xs text-[var(--color-text-muted)] truncate">
        {selected ? (
          <span>
            <b className="text-[var(--color-text)]">{selected.name}</b>
            {` · ${xMetric.nameShortRu || xMetric.nameRu}: ${fmtMetricValue(selected.x ?? null, xMetric)}`}
            {` · ${yMetric.nameShortRu || yMetric.nameRu}: ${fmtMetricValue(selected.values[0], yMetric)}`}
          </span>
        ) : (
          <span>Нажмите на точку, чтобы увидеть, кто это</span>
        )}
      </div>
      {/* тут preserveAspectRatio по умолчанию (meet) — внутри SVG есть числовые тики,
          растягивать их нельзя; на узком экране график просто пропорционально мельче */}
      <svg viewBox={`0 0 ${SW} ${SH}`} width="100%" className="block select-none">
        {[0, 0.25, 0.5, 0.75, 1].map(t => (
          <g key={t}>
            <line x1={S_PAD.l} x2={SW - S_PAD.r} y1={S_PAD.t + (1 - t) * innerH} y2={S_PAD.t + (1 - t) * innerH}
              stroke="var(--color-border)" strokeWidth={1} strokeDasharray={t === 0 ? undefined : '4 4'} />
            <text x={S_PAD.l - 6} y={S_PAD.t + (1 - t) * innerH + 4} textAnchor="end" fontSize={11} fill="var(--color-text-muted)">
              {fmtCompact(maxY * t)}
            </text>
            {t > 0 && (
              <line x1={S_PAD.l + t * innerW} x2={S_PAD.l + t * innerW} y1={S_PAD.t} y2={S_PAD.t + innerH}
                stroke="var(--color-border)" strokeWidth={1} strokeDasharray="4 4" />
            )}
            <text x={S_PAD.l + t * innerW} y={SH - 8} textAnchor="middle" fontSize={11} fill="var(--color-text-muted)">
              {fmtCompact(maxX * t)}
            </text>
          </g>
        ))}
        {pts.map(e => {
          const cx = S_PAD.l + ((e.x as number) / maxX) * innerW;
          const cy = S_PAD.t + (1 - (e.values[0] as number) / maxY) * innerH;
          const active = sel === e.id;
          return (
            <circle
              key={e.id} cx={cx} cy={cy} r={active ? 7 : 4.5}
              fill="var(--color-accent)" fillOpacity={active ? 0.95 : 0.55}
              stroke={active ? 'var(--color-accent)' : 'none'} strokeWidth={2}
              className="cursor-pointer"
              onClick={() => setSel(active ? null : e.id)}
            >
              <title>{e.name}</title>
            </circle>
          );
        })}
      </svg>
      <div className="mt-0.5 text-center text-[10px] text-[var(--color-text-muted)]">
        по горизонтали — {xMetric.nameRu}; по вертикали — {yMetric.nameRu}
      </div>
    </div>
  );
}
