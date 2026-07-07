'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface BranchMetrics {
  name: string;
  fact_ytd: number;
  target_year: number | null;
  plan_percent_cumulative: number | null;
  plan_percent_pace: number | null;
  departments?: BranchMetrics[];
}

interface PlanSummary {
  updated_at: string;
  russia: BranchMetrics;
  branches: BranchMetrics[];
}

function fmtMoney(n: number) {
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

function fmtPct(n: number | null) {
  return n === null ? '—' : `${n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}

function fmtUpdatedAt(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function paceColorClass(pace: number | null) {
  if (pace === null) return 'text-[var(--color-text-muted)]';
  return pace >= 100 ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]';
}

function MetricPair({ metrics, size }: { metrics: BranchMetrics; size: 'lg' | 'sm' }) {
  // на 375px два числа text-5xl в ряд не влезают — на телефоне на ступень меньше
  const bigNum = size === 'lg' ? 'text-4xl sm:text-5xl' : 'text-2xl';
  const label = size === 'lg' ? 'text-sm' : 'text-xs';
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      <div>
        <div className={`${bigNum} font-bold tabular-nums text-[var(--color-text)]`}>
          {fmtPct(metrics.plan_percent_cumulative)}
        </div>
        <div className={`${label} text-[var(--color-text-muted)]`}>Выполнено с начала года</div>
      </div>
      <div>
        <div className={`${bigNum} font-bold tabular-nums ${paceColorClass(metrics.plan_percent_pace)}`}>
          {fmtPct(metrics.plan_percent_pace)}
        </div>
        <div className={`${label} text-[var(--color-text-muted)]`}>Темп к рабочему дню</div>
      </div>
    </div>
  );
}

function BranchCard({ branch }: { branch: BranchMetrics }) {
  const [expanded, setExpanded] = useState(false);
  const hasDepartments = (branch.departments?.length ?? 0) > 0;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] overflow-hidden">
      <div
        className={`px-4 py-3 ${hasDepartments ? 'cursor-pointer hover:bg-[var(--color-bg-hover)]' : ''}`}
        onClick={hasDepartments ? () => setExpanded(v => !v) : undefined}
      >
        <div className="flex items-center gap-1.5 mb-1.5">
          {hasDepartments && (
            expanded ? <ChevronDown size={12} className="text-[var(--color-text-muted)]" /> : <ChevronRight size={12} className="text-[var(--color-text-muted)]" />
          )}
          <div className="text-xs font-semibold text-[var(--color-text)]">{branch.name}</div>
        </div>
        {branch.target_year === null ? (
          <p className="text-xs text-[var(--color-text-muted)]">План не задан</p>
        ) : (
          <MetricPair metrics={branch} size="sm" />
        )}
      </div>

      {hasDepartments && expanded && (
        <div className="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
          {branch.departments!.map(dept => (
            <div key={dept.name} className="pl-8 pr-4 py-2.5 bg-[var(--color-bg)]">
              <div className="text-xs font-medium text-[var(--color-text-muted)] mb-1">{dept.name}</div>
              {dept.target_year === null ? (
                <p className="text-xs text-[var(--color-text-muted)]">План не задан</p>
              ) : (
                <MetricPair metrics={dept} size="sm" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SummaryPage() {
  const { data, isLoading, isError, refetch } = useQuery<PlanSummary>({
    queryKey: ['summary-plan'],
    queryFn: async () => {
      const res = await fetch('/api/summary/plan');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 25_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  return (
    <div className="flex flex-col h-full overflow-auto bg-[var(--color-bg)]">
      <div className="px-4 py-3 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex items-baseline justify-between gap-3 sticky top-0 z-10">
        <h1 className="text-sm font-semibold text-[var(--color-text)]">Сводная</h1>
        <span className="text-xs text-[var(--color-text-muted)]">
          {data && `Обновлено: ${fmtUpdatedAt(data.updated_at)}`}
        </span>
      </div>

      <div className="flex-1 px-4 py-4 flex flex-col gap-4 max-w-md mx-auto w-full">
        {isLoading && (
          <p className="text-sm text-[var(--color-text-muted)]">Загрузка…</p>
        )}

        {isError && (
          <div className="rounded-lg border border-[var(--color-negative)]/30 bg-[var(--color-negative)]/10 px-4 py-3">
            <p className="text-sm text-[var(--color-negative)]">Не удалось получить данные (кэш пуст или устарел).</p>
            <button
              onClick={() => refetch()}
              className="mt-2 text-xs underline text-[var(--color-text-muted)]"
            >
              Повторить
            </button>
          </div>
        )}

        {data && (
          <>
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
                Россия
              </div>
              <MetricPair metrics={data.russia} size="lg" />
              <div className="mt-3 text-xs text-[var(--color-text-muted)] tabular-nums">
                {fmtMoney(data.russia.fact_ytd)}
                {data.russia.target_year !== null && ` из ${fmtMoney(data.russia.target_year)}`}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {data.branches
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
                .map(b => <BranchCard key={b.name} branch={b} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
