'use client';

import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import type { CalledToSaleCohortPoint } from '../engine/types';

// Когорта «Созвонился → продажа по дням» (задача 2533) — тот же визуальный язык,
// что SurvivalChart.tsx: серые столбики на скрытой оси — размер когорты «дожили
// минимум N дней, не продав раньше» (day-N at risk), акцентная линия с точками —
// сколько из них продалось РОВНО на день N (не CR%, а абсолютное число — так
// читается «дожили 100, из них 15 продали»).
//
// Клик по точке (задача 2546) → onPointClick, дальше ChartsPage.tsx открывает
// ChartDrilldownPanel с сегментированным переключателем «Все N (cohort) /
// Продано M (sold)» — оба числа из того же point, второго запроса не нужно.

function CohortTooltip({ active, payload }: {
  active?: boolean;
  payload?: { payload: CalledToSaleCohortPoint }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold text-[var(--color-text)] mb-0.5">день {p.label}</div>
      <div className="text-[var(--color-text-muted)]">дожили минимум {p.label} дн.: <b className="text-[var(--color-text)]">{p.cohort.toLocaleString('ru-RU')}</b></div>
      <div className="text-[var(--color-text-muted)]">продано именно на этот день: <b className="text-[var(--color-text)]">{p.sold.toLocaleString('ru-RU')}</b></div>
      <div className="text-[var(--color-text-muted)]">доля: <b className="text-[var(--color-text)]">{p.pct === null ? '—' : `${p.pct}%`}</b></div>
    </div>
  );
}

export function CalledToSaleCohortChart({ points, accent, onPointClick }: {
  points: CalledToSaleCohortPoint[]; accent?: string; onPointClick?: (point: CalledToSaleCohortPoint) => void;
}) {
  const color = accent ?? 'var(--color-accent)';
  const maxSold = Math.max(1, ...points.map(p => p.sold));

  function handleClick(state: { activeLabel?: string | number } | null) {
    if (!onPointClick || !state?.activeLabel) return;
    const point = points.find(p => p.label === String(state.activeLabel));
    if (point && point.cohort > 0) onPointClick(point);
  }

  return (
    <div>
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            onClick={handleClick}
            style={onPointClick ? { cursor: 'pointer' } : undefined}
          >
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 9, fill: 'var(--color-text-muted)' }}
              axisLine={false} tickLine={false}
              interval={2} minTickGap={2}
            />
            <YAxis
              yAxisId="sold" domain={[0, Math.ceil(maxSold * 1.15)]}
              tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
              axisLine={false} tickLine={false}
              width={36}
            />
            {/* Когорта («дожили минимум N дней») — своя скрытая шкала, столбики
                только для чувства масштаба, тот же приём, что в SurvivalChart. */}
            <YAxis yAxisId="cohort" hide domain={[0, (dataMax: number) => Math.max(1, dataMax * 1.8)]} />
            <Tooltip content={<CohortTooltip />} cursor={{ fill: 'var(--color-bg-hover)', fillOpacity: 0.5 }} />
            <Bar yAxisId="cohort" dataKey="cohort" fill="var(--color-text-muted)" fillOpacity={0.18} radius={[3, 3, 0, 0]} animationDuration={400} />
            <Line
              yAxisId="sold" dataKey="sold" type="linear"
              stroke={color} strokeWidth={2.5}
              dot={{ r: 3, strokeWidth: 0, fill: color }}
              activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--color-bg-surface)' }}
              connectNulls animationDuration={400}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-0.5 text-center text-[10px] text-[var(--color-text-muted)]">
        дней от входа в «Созвонился и озвучил цены» до продажи · серые столбики — «дожили минимум N дней, не продав раньше» · линия — продано ровно на этот день
        {onPointClick && ' · клик — список сделок'}
      </div>
    </div>
  );
}
