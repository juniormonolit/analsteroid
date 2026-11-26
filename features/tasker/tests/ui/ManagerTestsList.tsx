'use client';
import { useQuery } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import type { ManagerTestsResponse } from '../types';
import { TESTS_KEY, getJson } from './api';
import { STATE_CLS, STATE_LABEL, fmtDay, fmtScore } from './format';

/** Тесты менеджера в карточке (блок «Задачи и обучения»): пройденные и назначенные. Нет таблиц/доступа — молчит. */
export function ManagerTestsList({ managerId }: { managerId: string }) {
  const q = useQuery({
    queryKey: [...TESTS_KEY, 'manager', managerId],
    queryFn: () => getJson<ManagerTestsResponse>(`/api/tasker/tests/manager?managerId=${managerId}`),
    retry: false,
    staleTime: 60_000,
  });
  const rows = q.data?.rows ?? [];
  if (q.isError || !rows.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text-secondary)]"><ListChecks size={14} aria-hidden /> Тесты</h4>
      <ul className="flex min-w-0 flex-col gap-1">
        {rows.slice(0, 8).map(r => (
          <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[13px]">
            <span className="min-w-0 flex-1 truncate">{r.testTitle}</span>
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATE_CLS[r.state]}`}>{STATE_LABEL[r.state]}</span>
            <span className="w-10 text-right tabular-nums">{r.last ? fmtScore(r.last.scorePercent) : ''}</span>
            <span className="text-[11.5px] text-[var(--color-text-muted)]">{r.last?.submittedAt ? fmtDay(r.last.submittedAt) : `до ${fmtDay(r.dueAt)}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
