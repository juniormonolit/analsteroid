'use client';
// График «Динамика продаж за период» в ЛК менеджера — Recharts (решение владельца
// 29.07: прежняя конвенция «без chart-либ» снята, дашборду нужен интерактив —
// тултипы, ховер, анимация). Тема — через CSS-переменные приложения.
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import type { DateRange } from '@/lib/period';
import type { CardSegment } from '@/features/manager-card/engine/managerCard';

interface DayPoint { date: string; salesCount: number; salesAmount: number }

function fmtMoneyShort(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  if (abs >= 1_000) return `${(v / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} тыс ₽`;
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}
function fmtDateRu(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  return `${d}.${m}`;
}

function ChartTooltip({ active, payload }: {
  active?: boolean;
  payload?: { payload: DayPoint }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold text-[var(--color-text)] mb-0.5">{fmtDateRu(p.date)}</div>
      <div className="text-[var(--color-text)] font-bold tabular-nums">{fmtMoneyShort(p.salesAmount)}</div>
      <div className="text-[var(--color-text-muted)]">{p.salesCount > 0 ? `${p.salesCount} прод.` : 'без продаж'}</div>
    </div>
  );
}

export function ManagerDailySalesCard({ managerId, mode, period, segment }: {
  managerId: string; mode: 'manager' | 'department'; period: DateRange; segment: CardSegment;
}) {
  const fromIso = period.from.toISOString();
  const toIso = period.to.toISOString();
  const { data, isLoading } = useQuery({
    queryKey: ['manager-card-daily-sales', mode, managerId, fromIso, toIso, segment],
    queryFn: async () => {
      const body = mode === 'department'
        ? { mode, departmentId: managerId, from: fromIso, to: toIso, segment }
        : { managerId, from: fromIso, to: toIso, segment };
      const res = await fetch('/api/manager-card/daily-sales', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Ошибка графика');
      return res.json() as Promise<{ days: DayPoint[] }>;
    },
    staleTime: 60_000,
  });

  if (isLoading) return <div className="h-[240px] rounded-lg bg-[var(--color-border)] animate-pulse" />;
  const days = data?.days ?? [];
  if (days.length === 0 || days.every(d => d.salesAmount === 0)) {
    return <p className="text-sm text-[var(--color-text-muted)]">Нет продаж за период.</p>;
  }
  const total = days.reduce((s, d) => s + d.salesAmount, 0);

  return (
    <div>
      <div className="h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={days} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickFormatter={fmtDateRu}
              tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
              axisLine={false} tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}М` : v >= 1_000 ? `${Math.round(v / 1000)}К` : String(v))}
              tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
              axisLine={false} tickLine={false}
              width={44}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--color-border-focus, var(--color-border))', strokeDasharray: '4 4' }} />
            <Area
              type="monotone"
              dataKey="salesAmount"
              stroke="var(--color-accent)"
              strokeWidth={2.5}
              fill="url(#salesFill)"
              activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--color-bg-surface)' }}
              animationDuration={500}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 text-right text-[11px] text-[var(--color-text-muted)]">
        Итого за период: <b className="text-[var(--color-text)]">{fmtMoneyShort(total)}</b>
      </div>
    </div>
  );
}
