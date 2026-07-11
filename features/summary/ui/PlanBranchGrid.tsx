'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { fmtMoney, fmtPct, fmtUpdatedAt, REPORT_LINKS } from './format';
import type { BranchValue } from './BranchFilter';

interface BranchMetrics {
  name: string;
  fact_ytd: number;
  target_year: number | null;
  target_to_date: number | null;
  plan_percent_cumulative: number | null;
  plan_percent_pace: number | null;
  departments?: BranchMetrics[];
}

interface PlanSummary {
  updated_at: string;
  russia: BranchMetrics;
  branches: BranchMetrics[];
}

function paceColorClass(pace: number | null) {
  if (pace === null) return 'text-[var(--color-text-muted)]';
  return pace >= 100 ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]';
}

function MetricPair({ metrics, size }: { metrics: BranchMetrics; size: 'lg' | 'sm' }) {
  const bigNum = size === 'lg' ? 'text-4xl sm:text-5xl' : 'text-2xl';
  const label = size === 'lg' ? 'text-sm' : 'text-xs';
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      <div>
        <div className={`${bigNum} font-bold tabular-nums text-[var(--color-text)]`}>{fmtPct(metrics.plan_percent_cumulative)}</div>
        <div className={`${label} text-[var(--color-text-muted)]`}>Выполнено с начала года</div>
      </div>
      <div>
        <div className={`${bigNum} font-bold tabular-nums ${paceColorClass(metrics.plan_percent_pace)}`}>{fmtPct(metrics.plan_percent_pace)}</div>
        <div className={`${label} text-[var(--color-text-muted)]`}>Темп к плану на сегодня</div>
      </div>
    </div>
  );
}

// Карточка НЕ оборачивается целиком в <Link> — заголовок с шевроном уже свой
// клик-тумблер (раскрытие отделов, «без изменений в поведении», мокап п.3
// брифа задачи 1704); обёртка всей карточки в <a> сделала бы каждый клик по
// шеврону одновременно и раскрытием, и переходом (гонка/сломанный UX). Переход
// в /plans — отдельная явная ссылка в подвале карточки.
function BranchCard({ branch, size }: { branch: BranchMetrics; size: 'lg' | 'sm' }) {
  const [expanded, setExpanded] = useState(false);
  const hasDepartments = (branch.departments?.length ?? 0) > 0;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] overflow-hidden h-fit">
      <div
        className={`px-5 py-4 ${hasDepartments ? 'cursor-pointer hover:bg-[var(--color-bg-hover)]' : ''}`}
        onClick={hasDepartments ? () => setExpanded(v => !v) : undefined}
      >
        <div className="flex items-center gap-1.5 mb-2">
          {hasDepartments && (expanded ? <ChevronDown size={12} className="text-[var(--color-text-muted)]" /> : <ChevronRight size={12} className="text-[var(--color-text-muted)]" />)}
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{branch.name}</div>
        </div>
        {branch.target_year === null ? (
          <p className="text-sm text-[var(--color-text-muted)]">План не задан</p>
        ) : (
          <MetricPair metrics={branch} size={size} />
        )}
        {size === 'lg' && (
          <div className="mt-3 text-xs text-[var(--color-text-muted)] tabular-nums">
            {fmtMoney(branch.fact_ytd)}
            {branch.target_year !== null && ` из ${fmtMoney(branch.target_year)}`}
          </div>
        )}
        <Link
          href={REPORT_LINKS.plans}
          onClick={e => e.stopPropagation()}
          className="inline-block mt-3 text-xs text-[var(--color-accent)] hover:underline"
        >
          Открыть план →
        </Link>
      </div>

      {hasDepartments && expanded && (
        <div className="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
          {branch.departments!.map(dept => (
            <div key={dept.name} className="pl-8 pr-5 py-2.5 bg-[var(--color-bg)]">
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

function ProblemZoneBanner({ branches }: { branches: BranchMetrics[] }) {
  const withPace = branches.filter(b => b.plan_percent_pace !== null);
  if (withPace.length < 2) return null; // сравнивать не с кем (единственный филиал в фильтре, или пейс не считается)

  const worst = withPace.reduce((min, b) => (b.plan_percent_pace! < min.plan_percent_pace! ? b : min));
  if (worst.plan_percent_pace! >= 100) return null; // все в норме — банер не нужен

  const norm = 100;
  const gap = Math.round((norm - worst.plan_percent_pace!) * 10) / 10;

  return (
    <Link
      href={REPORT_LINKS.plans}
      className="flex items-start gap-3 rounded-xl border border-[var(--color-negative)]/30 bg-[var(--color-negative)]/10 px-5 py-4 hover:border-[var(--color-negative)] transition-colors"
    >
      <AlertTriangle size={20} className="text-[var(--color-negative)] shrink-0 mt-0.5" />
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-negative)] mb-1">Проблемная зона</div>
        <p className="text-sm text-[var(--color-text)]">
          <strong>{worst.name}</strong> — самый слабый темп к плану: <strong className="text-[var(--color-negative)]">{fmtPct(worst.plan_percent_pace)}</strong>.
          {' '}Ниже нормы на {gap.toLocaleString('ru-RU')} п.п.
        </p>
      </div>
    </Link>
  );
}

function Skeleton() {
  return (
    <>
      <div className="h-40 rounded-xl bg-[var(--color-border)] animate-pulse" />
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-32 rounded-xl bg-[var(--color-border)] animate-pulse" />)}
      </div>
    </>
  );
}

export function PlanBranchGrid({ branch }: { branch: BranchValue }) {
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

  if (isLoading) return <Skeleton />;

  if (isError || !data) {
    return (
      <div className="rounded-xl border border-[var(--color-negative)]/30 bg-[var(--color-negative)]/10 px-5 py-4">
        <p className="text-sm text-[var(--color-negative)]">Не удалось получить данные плана (кэш пуст или устарел).</p>
        <button onClick={() => refetch()} className="mt-2 text-xs underline text-[var(--color-text-muted)]">Повторить</button>
      </div>
    );
  }

  const sortedBranches = data.branches.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const filtered = branch === 'all' ? sortedBranches : sortedBranches.filter(b => b.name === branch);

  return (
    <>
      <div className="text-[11px] text-[var(--color-text-muted)] -mb-1">Обновлено (план): {fmtUpdatedAt(data.updated_at)}</div>
      {branch === 'all' && <BranchCard branch={data.russia} size="lg" />}

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {filtered.map(b => <BranchCard key={b.name} branch={b} size={branch === 'all' ? 'sm' : 'lg'} />)}
      </div>

      {branch === 'all' && <ProblemZoneBanner branches={data.branches} />}
    </>
  );
}
