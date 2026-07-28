'use client';

import { useState } from 'react';
import type { SurvivalBucket } from '../engine/types';

// Кривая «вероятность продажи от дней в стадии»: серые столбики — размер когорты
// в корзине (правой шкалы нет — они только для чувства масштаба), акцентная линия
// с точками — CR в продажу. Самописный SVG (конвенция проекта — сторонних
// chart-либ нет, см. DailySalesChart.tsx). Тап/клик по корзине — детали в строке
// над графиком (hover-only тултипов нет — правило тач-доступности CLAUDE.md).
const W = 720;
const H = 240;
const PAD_T = 14;
const PAD_B = 6;
const PAD_X = 6;

export function SurvivalChart({ buckets, accent }: { buckets: SurvivalBucket[]; accent?: string }) {
  const [sel, setSel] = useState<number | null>(null);

  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_T - PAD_B;
  const n = buckets.length;
  const slotW = innerW / n;

  const maxPct = Math.max(5, ...buckets.map(b => b.pct ?? 0));
  const maxTotal = Math.max(1, ...buckets.map(b => b.total));
  const color = accent ?? 'var(--color-accent)';

  const pts = buckets.map((b, i) => {
    const x = PAD_X + slotW * i + slotW / 2;
    const y = b.pct === null ? null : PAD_T + (1 - b.pct / maxPct) * innerH;
    return { x, y };
  });
  const linePts = pts.filter((p): p is { x: number; y: number } => p.y !== null);
  const linePath = linePts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = linePts.length > 1
    ? `${linePath} L${linePts[linePts.length - 1].x.toFixed(1)},${(PAD_T + innerH).toFixed(1)} L${linePts[0].x.toFixed(1)},${(PAD_T + innerH).toFixed(1)} Z`
    : '';

  const selected = sel !== null ? buckets[sel] : null;

  return (
    <div>
      <div className="h-5 mb-1 text-xs text-[var(--color-text-muted)]">
        {selected ? (
          <span>
            <b className="text-[var(--color-text)]">{selected.label} дн.</b>
            {' · сделок: '}<b className="text-[var(--color-text)]">{selected.total}</b>
            {' · продано: '}<b className="text-[var(--color-text)]">{selected.sold}</b>
            {' · CR: '}<b className="text-[var(--color-text)]">{selected.pct === null ? '—' : `${selected.pct}%`}</b>
          </span>
        ) : (
          <span>Нажмите на столбик, чтобы увидеть цифры корзины</span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" className="block select-none">
        {/* сетка по CR: 4 горизонтали */}
        {[0.25, 0.5, 0.75, 1].map(t => (
          <line
            key={t}
            x1={PAD_X} x2={W - PAD_X}
            y1={PAD_T + (1 - t) * innerH} y2={PAD_T + (1 - t) * innerH}
            stroke="var(--color-border)" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* серые столбики когорты */}
        {buckets.map((b, i) => {
          const bh = (b.total / maxTotal) * innerH * 0.55;
          return (
            <rect
              key={b.label}
              x={PAD_X + slotW * i + slotW * 0.18}
              y={PAD_T + innerH - bh}
              width={slotW * 0.64}
              height={bh}
              fill="var(--color-text-muted)"
              fillOpacity={sel === i ? 0.42 : 0.18}
            />
          );
        })}
        {areaPath && <path d={areaPath} fill={color} fillOpacity={0.10} stroke="none" />}
        {linePath && (
          <path d={linePath} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        )}
        {pts.map((p, i) => p.y !== null && (
          <circle key={i} cx={p.x} cy={p.y} r={sel === i ? 5 : 3} fill={color} />
        ))}
        {/* прозрачные зоны клика на всю высоту */}
        {buckets.map((b, i) => (
          <rect
            key={`hit-${b.label}`}
            x={PAD_X + slotW * i} y={0} width={slotW} height={H}
            fill="transparent" className="cursor-pointer"
            onClick={() => setSel(sel === i ? null : i)}
          />
        ))}
      </svg>
      {/* подписи корзин — HTML, чтобы не искажались preserveAspectRatio="none" */}
      <div className="grid mt-1" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
        {buckets.map((b, i) => (
          <button
            key={b.label}
            type="button"
            onClick={() => setSel(sel === i ? null : i)}
            className={`text-[9px] sm:text-[10px] leading-tight text-center truncate ${sel === i ? 'text-[var(--color-text)] font-semibold' : 'text-[var(--color-text-muted)]'}`}
          >
            {b.label}
          </button>
        ))}
      </div>
      <div className="mt-0.5 text-center text-[10px] text-[var(--color-text-muted)]">дней в стадии</div>
    </div>
  );
}
