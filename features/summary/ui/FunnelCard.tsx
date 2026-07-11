'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { REPORT_LINKS } from './format';
import type { BranchValue } from './BranchFilter';

interface FunnelStage { key: string; label: string; count: number; pct: number }
interface SummaryFunnelResponse { hasAccess: boolean; stages: FunnelStage[]; dataAvailable: boolean }

function Skeleton() {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-4">
      <div className="h-3 w-56 bg-[var(--color-border)] rounded animate-pulse mb-4" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-6 bg-[var(--color-border)] rounded animate-pulse" />)}
      </div>
    </div>
  );
}

export function FunnelCard({ branch }: { branch: BranchValue }) {
  const { data, isLoading, isError } = useQuery<SummaryFunnelResponse>({
    queryKey: ['summary-funnel', branch],
    queryFn: async () => {
      const res = await fetch(`/api/summary/funnel?branch=${branch}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 120_000,
    retry: false,
  });

  if (isLoading) return <Skeleton />;

  if (isError) {
    return (
      <div className="rounded-xl border border-[var(--color-negative)]/30 bg-[var(--color-negative)]/10 px-5 py-4">
        <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить воронку конверсии.</p>
      </div>
    );
  }

  return (
    <Link
      href={REPORT_LINKS.conversions}
      className="block rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-4 hover:border-[var(--color-accent)] transition-colors"
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-4">Конверсия воронки за период</div>

      {!data?.hasAccess ? (
        <p className="text-sm text-[var(--color-text-muted)]">Отделы не назначены. Обратитесь к администратору.</p>
      ) : !data.dataAvailable ? (
        <p className="text-sm text-[var(--color-text-muted)]">Нет данных за выбранный период (раньше начала сбора событий по стадиям).</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {data.stages.map(s => (
            <div key={s.key} className="flex items-center gap-3">
              <div className="w-32 sm:w-36 shrink-0 text-xs text-[var(--color-text-muted)] truncate">{s.label}</div>
              <div className="flex-1 h-4 rounded bg-[var(--color-bg)] overflow-hidden">
                <div
                  className="h-full rounded bg-[var(--color-accent)]"
                  style={{ width: `${Math.max(2, Math.min(100, s.pct))}%`, opacity: 0.35 + (s.pct / 100) * 0.65 }}
                />
              </div>
              <div className="w-14 shrink-0 text-right text-sm font-bold tabular-nums text-[var(--color-text)]">{s.pct}%</div>
            </div>
          ))}
        </div>
      )}
    </Link>
  );
}
