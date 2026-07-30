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

// Формат денег — тот же, что в отчётах (fmtMoney в DrilldownDrawer.tsx):
// «1 234 567 ₽». 0 — валидная сумма (не «—»). `|| 0` нормализует «-0»:
// after на последней точке — total-before-day, float-остаток порядка 1e-8
// может быть отрицательным и без нормализации печатался бы «-0 ₽».
function fmtRub(v: number): string {
  return (Math.round(v) || 0).toLocaleString('ru-RU') + ' ₽';
}

// Одна строка блока сумм: подпись, сумма, доля от общей суммы проданных.
function AmountRow({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 1000) / 10 : null;
  return (
    <div className="flex items-baseline justify-between gap-3 text-[var(--color-text-muted)]">
      <span>{label}</span>
      <span className="tabular-nums whitespace-nowrap">
        <b className="text-[var(--color-text)]">{fmtRub(value)}</b>
        <span className="ml-1">· {pct === null ? '—' : `${pct}%`}</span>
      </span>
    </div>
  );
}

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
      {/* Суммы проданного вокруг дня (задача 30.07, владелец: «навестись на
          кагорту и понять сколько заработали слева, справа и сегодня») —
          Σ d.amount проданных сделок по дням < N / = N / > N, доля от общей
          суммы проданных когорты. before+day+after = total на каждой точке
          (см. buildLifeTablePoints). Фильтры страницы (в т.ч. «Чек от/до»)
          уже применены — суммы считаются по той же когорте, что и график. */}
      {p.amounts && (
        <div className="mt-1.5 pt-1.5 border-t border-[var(--color-border)]">
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mb-0.5">суммы проданного</div>
          <AmountRow label="до этого дня" value={p.amounts.before} total={p.amounts.total} />
          <AmountRow label="этот день" value={p.amounts.day} total={p.amounts.total} />
          <AmountRow label="с этого дня (позже)" value={p.amounts.after} total={p.amounts.total} />
        </div>
      )}
      {/* Разбивка проданных дня по kc-группам (задача 2599) — блок появляется,
          только если точка её несёт (сейчас — пятый график, см. groups в
          engine/types.ts); у 3-го/4-го графиков поле пустое и тултип прежний. */}
      {p.groups && p.groups.length > 0 && (
        <div className="mt-1.5 pt-1.5 border-t border-[var(--color-border)]">
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mb-0.5">по группам КЦ</div>
          {p.groups.map(g => (
            <div key={g.name} className="flex items-baseline justify-between gap-3 text-[var(--color-text-muted)]">
              <span className="truncate max-w-[180px]">{g.name}</span>
              <b className="text-[var(--color-text)] tabular-nums">{g.count.toLocaleString('ru-RU')}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CalledToSaleCohortChart({ points, accent, onPointClick, axisLabel }: {
  points: CalledToSaleCohortPoint[];
  accent?: string;
  onPointClick?: (point: CalledToSaleCohortPoint) => void;
  // Подпись оси X под графиком (задача 2553): компонент переиспользуется для
  // РАЗНЫХ «дней» (календарные от входа в «Созвонился…» vs накопленные в WORK) —
  // единственный кусок текста, который знает про конкретную когорту, поэтому
  // вынесен наружу вместо хардкода. Дефолт — исходная подпись (задача 2533),
  // чтобы не трогать существующего вызывающего.
  axisLabel?: string;
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
        {axisLabel ?? 'дней от входа в «Созвонился и озвучил цены» до продажи'} · серые столбики — «дожили минимум N дней, не продав раньше» · линия — продано ровно на этот день
        {onPointClick && ' · клик — список сделок'}
      </div>
    </div>
  );
}
