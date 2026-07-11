'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { fmtInt, fmtMoney, fmtPct, REPORT_LINKS } from './format';
import type { BranchValue } from './BranchFilter';

interface SummaryTodayResponse {
  hasAccess: boolean;
  deals: number;
  salesAmount: number;
  calls: number;
  conversionPct: number | null;
  updatedAt: string;
}

function Skeleton() {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-4">
      <div className="h-3 w-16 bg-[var(--color-border)] rounded animate-pulse mb-4" />
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <div className="h-8 w-16 bg-[var(--color-border)] rounded animate-pulse mb-2" />
            <div className="h-3 w-20 bg-[var(--color-border)] rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function TodayTile({ branch }: { branch: BranchValue }) {
  const { data, isLoading, isError } = useQuery<SummaryTodayResponse>({
    queryKey: ['summary-today', branch],
    queryFn: async () => {
      const res = await fetch(`/api/summary/today?branch=${branch}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  if (isLoading) return <Skeleton />;

  if (isError) {
    return (
      <div className="rounded-xl border border-[var(--color-negative)]/30 bg-[var(--color-negative)]/10 px-5 py-4">
        <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить «Сегодня».</p>
      </div>
    );
  }

  if (!data?.hasAccess) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">Сегодня</div>
        <p className="text-sm text-[var(--color-text-muted)]">Отделы не назначены. Обратитесь к администратору.</p>
      </div>
    );
  }

  const tiles = [
    { label: 'Сделки', value: fmtInt(data.deals) },
    { label: 'Продажи, ₽', value: fmtMoney(data.salesAmount) },
    { label: 'Звонки', value: fmtInt(data.calls) },
    { label: 'Конверсия звонок→сделка', value: fmtPct(data.conversionPct) },
  ];

  return (
    <Link
      href={REPORT_LINKS.ropMonitor}
      className="block rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-4 hover:border-[var(--color-accent)] transition-colors"
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-3">Сегодня</div>
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
        {tiles.map(t => (
          <div key={t.label}>
            <div className="text-2xl sm:text-4xl font-bold tabular-nums text-[var(--color-text)]">{t.value}</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-1">{t.label}</div>
          </div>
        ))}
      </div>
    </Link>
  );
}
