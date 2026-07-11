'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { fmtInt, REPORT_LINKS } from './format';
import type { BranchValue } from './BranchFilter';

interface TopManagerRow { managerId: string; name: string; login: string | null; salesCount: number }
interface SummaryTopManagersResponse { hasAccess: boolean; managers: TopManagerRow[] }

function Skeleton() {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-4">
      <div className="h-3 w-40 bg-[var(--color-border)] rounded animate-pulse mb-4" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-8 bg-[var(--color-border)] rounded animate-pulse" />)}
      </div>
    </div>
  );
}

export function TopManagersCard({ branch }: { branch: BranchValue }) {
  const { data, isLoading, isError } = useQuery<SummaryTopManagersResponse>({
    queryKey: ['summary-top-managers', branch],
    queryFn: async () => {
      const res = await fetch(`/api/summary/top-managers?branch=${branch}`);
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
        <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить топ менеджеров.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-4 h-full">
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-3">Топ-5 менеджеров недели</div>

      {!data?.hasAccess ? (
        <p className="text-sm text-[var(--color-text-muted)]">Отделы не назначены. Обратитесь к администратору.</p>
      ) : data.managers.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Нет продаж за последние 7 дней в этом фильтре.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {data.managers.map((m, i) => (
            <li key={m.managerId}>
              <Link
                href={REPORT_LINKS.managers}
                className="flex items-center gap-3 py-1.5 px-1 -mx-1 rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                <span className="w-5 shrink-0 text-center text-xs font-semibold text-[var(--color-text-muted)] tabular-nums">{i + 1}</span>
                <span className="flex-1 min-w-0 truncate text-sm text-[var(--color-text)]">
                  {m.name}{m.login && <span className="text-[var(--color-text-muted)]"> {m.login}</span>}
                </span>
                <span className="text-sm font-bold tabular-nums text-[var(--color-text)]">{fmtInt(m.salesCount)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
