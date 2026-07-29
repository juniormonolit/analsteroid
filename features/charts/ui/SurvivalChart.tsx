'use client';

import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import type { SurvivalBucket } from '../engine/types';

// Кривая «вероятность продажи от дней в стадии» — Recharts (решение владельца 29.07):
// серые столбики — размер когорты в корзине (своя скрытая ось, только для чувства
// масштаба), акцентная линия с точками — CR в продажу. Интерактив — тултип по
// ховеру/тапу (дни, сделок, продано, CR) вместо прежнего клика по корзине.

function BucketTooltip({ active, payload }: {
  active?: boolean;
  payload?: { payload: SurvivalBucket }[];
}) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold text-[var(--color-text)] mb-0.5">{b.label} дн.</div>
      <div className="text-[var(--color-text-muted)]">сделок: <b className="text-[var(--color-text)]">{b.total.toLocaleString('ru-RU')}</b></div>
      <div className="text-[var(--color-text-muted)]">продано: <b className="text-[var(--color-text)]">{b.sold.toLocaleString('ru-RU')}</b></div>
      <div className="text-[var(--color-text-muted)]">CR: <b className="text-[var(--color-text)]">{b.pct === null ? '—' : `${b.pct}%`}</b></div>
    </div>
  );
}

export function SurvivalChart({ buckets, accent }: { buckets: SurvivalBucket[]; accent?: string }) {
  const color = accent ?? 'var(--color-accent)';
  const maxPct = Math.max(5, ...buckets.map(b => b.pct ?? 0));

  return (
    <div>
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={buckets} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: 'var(--color-text-muted)' }}
              axisLine={false} tickLine={false}
              interval={0} minTickGap={4}
            />
            <YAxis
              yAxisId="pct" domain={[0, Math.ceil(maxPct * 1.1)]}
              tickFormatter={(v: number) => `${v}%`}
              tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
              axisLine={false} tickLine={false}
              width={40}
            />
            {/* Когорта — своя скрытая шкала: столбики лишь для чувства масштаба,
                прижаты вниз (домен ×1.8), правой оси нет — как в прежней версии. */}
            <YAxis yAxisId="total" hide domain={[0, (dataMax: number) => Math.max(1, dataMax * 1.8)]} />
            <Tooltip content={<BucketTooltip />} cursor={{ fill: 'var(--color-bg-hover)', fillOpacity: 0.5 }} />
            <Bar yAxisId="total" dataKey="total" fill="var(--color-text-muted)" fillOpacity={0.18} radius={[3, 3, 0, 0]} animationDuration={400} />
            {/* type="linear" (НЕ monotone): корзины дискретные и неравномерные
                («13», «14–20», «21–30», «30+») — сплайн придумывал бы кривизну
                между ними и искажал форму. Ломаная = ровно измеренные точки. */}
            <Line
              yAxisId="pct" dataKey="pct" type="linear"
              stroke={color} strokeWidth={2.5}
              dot={{ r: 3, strokeWidth: 0, fill: color }}
              activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--color-bg-surface)' }}
              connectNulls animationDuration={400}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-0.5 text-center text-[10px] text-[var(--color-text-muted)]">дней в стадии · серые столбики — размер когорты</div>
    </div>
  );
}
