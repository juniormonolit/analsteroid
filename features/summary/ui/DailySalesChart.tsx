'use client';

import { useQuery } from '@tanstack/react-query';
import { fmtMoney } from './format';
import type { BranchValue } from './BranchFilter';

interface DailySalesPoint { date: string; salesCount: number; salesAmount: number }
interface SummaryDailySalesResponse { hasAccess: boolean; days: DailySalesPoint[] }

// Самописный SVG (тот же принцип, что features/manager-card/ui/ManagerCardRadar.tsx —
// сторонних chart-либ в проекте нет) — простая area+line спарклайн-диаграмма по сумме
// продаж/день, без осей/тултипов (компактный блок дашборда, не полноценный отчёт).
const WIDTH = 600;
const HEIGHT = 180;
const PAD_X = 4;
const PAD_TOP = 12;
const PAD_BOTTOM = 8;

function buildPath(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

function Chart({ days }: { days: DailySalesPoint[] }) {
  const values = days.map(d => d.salesAmount);
  const max = Math.max(1, ...values);
  const min = 0; // от нуля — так «рост» визуально честный, не преувеличенный обрезкой снизу
  const innerW = WIDTH - PAD_X * 2;
  const innerH = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const points = days.map((d, i) => {
    const x = PAD_X + (days.length > 1 ? (i / (days.length - 1)) * innerW : innerW / 2);
    const t = (d.salesAmount - min) / (max - min || 1);
    const y = PAD_TOP + (1 - t) * innerH;
    return { x, y };
  });

  const linePath = buildPath(points);
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${(PAD_TOP + innerH).toFixed(1)} L${points[0].x.toFixed(1)},${(PAD_TOP + innerH).toFixed(1)} Z`;

  const total = values.reduce((a, b) => a + b, 0);
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;

  return (
    <div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT} preserveAspectRatio="none" className="block">
        <path d={areaPath} fill="var(--color-accent)" fillOpacity={0.16} stroke="none" />
        <path d={linePath} fill="none" stroke="var(--color-accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {points.length > 0 && (
          <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={3.5} fill="var(--color-accent)" />
        )}
      </svg>
      <div className="flex justify-between mt-1 text-[11px] text-[var(--color-text-muted)]">
        <span>{first}</span>
        <span>Итого за период: {fmtMoney(total)} ₽</span>
        <span>{last}</span>
      </div>
    </div>
  );
}

function Skeleton() {
  return <div className="h-[180px] rounded-lg bg-[var(--color-border)] animate-pulse" />;
}

export function DailySalesChart({ branch }: { branch: BranchValue }) {
  const { data, isLoading, isError } = useQuery<SummaryDailySalesResponse>({
    queryKey: ['summary-daily-sales', branch],
    queryFn: async () => {
      const res = await fetch(`/api/summary/daily-sales?branch=${branch}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 120_000,
    retry: false,
  });

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-4 h-full">
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-3">Динамика продаж за 30 дней</div>

      {isLoading ? (
        <Skeleton />
      ) : isError ? (
        <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить график.</p>
      ) : !data?.hasAccess ? (
        <p className="text-sm text-[var(--color-text-muted)]">Отделы не назначены. Обратитесь к администратору.</p>
      ) : data.days.every(d => d.salesAmount === 0) ? (
        <p className="text-sm text-[var(--color-text-muted)]">Нет продаж за последние 30 дней в этом фильтре.</p>
      ) : (
        <Chart days={data.days} />
      )}
    </div>
  );
}
