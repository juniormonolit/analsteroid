'use client';

import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import type { MilestoneCohortPoint } from '../engine/types';

// Пятый график, ТРИ линии вместо одной (задача 2574, доработка 30.07):
// «на какой день конверсия в бронь/продажу/отгрузку становится ничтожной».
// Тот же визуальный язык, что CalledToSaleCohortChart.tsx (серые столбики —
// когорта «дожили минимум N дней», акцентная линия(и) — абсолютное число
// событий РОВНО на день N), но три линии на общей когорте вместо одной.
//
// ВАЖНО: одна сделка обычно проходит бронь → продажу → отгрузку на РАЗНЫЕ
// дни, поэтому попадает на все три линии в разных точках — линии друг из
// друга не вычитаются и в сумме не дают когорту (см. подпись под графиком).

const RESERVED_COLOR = '#f59e0b'; // амбер — «бронь»
const SOLD_COLOR = '#10b981';     // зелёный — «продажа»
const SHIPPED_COLOR = '#3b82f6';  // синий — «отгрузка»

function MilestoneTooltip({ active, payload }: {
  active?: boolean;
  payload?: { payload: MilestoneCohortPoint }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold text-[var(--color-text)] mb-0.5">день {p.label}</div>
      <div className="text-[var(--color-text-muted)]">дожили минимум {p.label} дн.: <b className="text-[var(--color-text)]">{p.cohort.toLocaleString('ru-RU')}</b></div>
      <div style={{ color: RESERVED_COLOR }}>бронь на этот день: <b>{p.reserved.toLocaleString('ru-RU')}</b></div>
      <div style={{ color: SOLD_COLOR }}>продажа на этот день: <b>{p.sold.toLocaleString('ru-RU')}</b></div>
      <div style={{ color: SHIPPED_COLOR }}>отгрузка на этот день: <b>{p.shipped.toLocaleString('ru-RU')}</b></div>
    </div>
  );
}

export function MilestoneCohortChart({ points, onPointClick, axisLabel }: {
  points: MilestoneCohortPoint[];
  onPointClick?: (point: MilestoneCohortPoint) => void;
  axisLabel?: string;
}) {
  const maxEvent = Math.max(1, ...points.map(p => Math.max(p.reserved, p.sold, p.shipped)));

  function handleClick(state: { activeLabel?: string | number } | null) {
    if (!onPointClick || !state?.activeLabel) return;
    const point = points.find(p => p.label === String(state.activeLabel));
    if (point && point.cohort > 0) onPointClick(point);
  }

  return (
    <div>
      <div className="h-[280px]">
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
              yAxisId="events" domain={[0, Math.ceil(maxEvent * 1.15)]}
              tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
              axisLine={false} tickLine={false}
              width={36}
            />
            {/* Когорта («дожили минимум N дней») — своя скрытая шкала, столбики
                только для чувства масштаба, тот же приём, что в SurvivalChart/
                CalledToSaleCohortChart. */}
            <YAxis yAxisId="cohort" hide domain={[0, (dataMax: number) => Math.max(1, dataMax * 1.8)]} />
            <Tooltip content={<MilestoneTooltip />} cursor={{ fill: 'var(--color-bg-hover)', fillOpacity: 0.5 }} />
            {/* content-рендер вместо formatter — Recharts иначе сортирует
                легенду не по порядку добавления серий (замечено визуально:
                показывал алфавитный порядок «бронь, когорта, отгрузка,
                продажа»). Порядок ниже — хронологический, как сделка идёт по
                воронке: когорта → бронь → продажа → отгрузка. */}
            <Legend
              verticalAlign="top" height={24}
              content={() => (
                <div className="flex items-center justify-center gap-4 pb-1.5 text-[11px] text-[var(--color-text-muted)]">
                  {[
                    { label: 'когорта (дожили)', color: 'var(--color-text-muted)' },
                    { label: 'бронь', color: RESERVED_COLOR },
                    { label: 'продажа', color: SOLD_COLOR },
                    { label: 'отгрузка', color: SHIPPED_COLOR },
                  ].map(item => (
                    <span key={item.label} className="inline-flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-sm" style={{ background: item.color }} />
                      {item.label}
                    </span>
                  ))}
                </div>
              )}
            />
            <Bar yAxisId="cohort" dataKey="cohort" name="когорта (дожили)" fill="var(--color-text-muted)" fillOpacity={0.18} radius={[3, 3, 0, 0]} animationDuration={400} />
            <Line
              yAxisId="events" dataKey="reserved" name="бронь" type="linear"
              stroke={RESERVED_COLOR} strokeWidth={2}
              dot={{ r: 2.5, strokeWidth: 0, fill: RESERVED_COLOR }}
              activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--color-bg-surface)' }}
              connectNulls animationDuration={400}
            />
            <Line
              yAxisId="events" dataKey="sold" name="продажа" type="linear"
              stroke={SOLD_COLOR} strokeWidth={2.5}
              dot={{ r: 2.5, strokeWidth: 0, fill: SOLD_COLOR }}
              activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--color-bg-surface)' }}
              connectNulls animationDuration={400}
            />
            <Line
              yAxisId="events" dataKey="shipped" name="отгрузка" type="linear"
              stroke={SHIPPED_COLOR} strokeWidth={2}
              dot={{ r: 2.5, strokeWidth: 0, fill: SHIPPED_COLOR }}
              activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--color-bg-surface)' }}
              connectNulls animationDuration={400}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-0.5 text-center text-[10px] text-[var(--color-text-muted)]">
        {axisLabel ?? 'дней в работе (без брони и подтверждения)'} · серые столбики — «дожили минимум N дней» ·
        линии — бронь/продажа/отгрузка ровно на этот день (одна сделка обычно попадает на все три линии
        в РАЗНЫЕ дни — линии не складываются в когорту)
        {onPointClick && ' · клик — список сделок'}
      </div>
    </div>
  );
}
