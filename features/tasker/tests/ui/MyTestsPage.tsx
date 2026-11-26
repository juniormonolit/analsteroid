'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ListChecks } from 'lucide-react';
import type { MyTestRow, MyTestsResponse } from '../types';
import { MY_TESTS_KEY, getJson } from './api';
import { STATE_CLS, STATE_LABEL, fmtDay, fmtDayTime, fmtScore } from './format';

export function useMyTestsCount(enabled: boolean) {
  return useQuery({
    queryKey: MY_TESTS_KEY,
    queryFn: () => getJson<MyTestsResponse>('/api/tasker/tests/my'),
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
}

/** ЛК → «Тесты»: назначенные (со сроком) и пройденные. Прохождение — /profile/tests/<id>. */
export function MyTestsPage() {
  const q = useMyTestsCount(true);
  const rows = q.data?.rows ?? [];
  const todo = rows.filter(r => r.canStart);
  const done = rows.filter(r => !r.canStart);

  return (
    <div className="mx-auto flex w-full max-w-[860px] min-w-0 flex-col gap-4 p-3 sm:p-5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-2.5">
        <h1 className="text-xl font-extrabold text-[var(--color-text)]">Тесты</h1>
        <span className="text-[13px] text-[var(--color-text-muted)]">по материалам обучений — назначает тренер или руководитель</span>
      </div>
      {q.isLoading ? <div className="h-20 animate-pulse rounded-xl bg-[var(--color-bg-surface)]" aria-busy />
        : q.isError ? <p className="text-sm text-[var(--color-negative)]">{(q.error as Error).message}</p>
        : rows.length === 0 ? (
          <div className="flex min-w-0 flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--color-border)] px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">
            <ListChecks size={24} aria-hidden />
            Назначенных тестов нет. Когда тренер назначит тест, придёт сообщение от «Аналитика», а тест появится здесь.
          </div>
        ) : (
          <>
            {todo.length > 0 && <Group title="Пройти" rows={todo} />}
            {done.length > 0 && <Group title="Пройденные" rows={done} />}
          </>
        )}
    </div>
  );
}

function Group({ title, rows }: { title: string; rows: MyTestRow[] }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{title}</h2>
      <ul className="flex min-w-0 flex-col gap-2">
        {rows.map(r => (
          <li key={r.assignmentId}>
            <Link href={`/profile/tests/${r.assignmentId}`}
              className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-3 hover:border-[var(--color-accent)]">
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="min-w-0 break-words font-medium">{r.testTitle}</span>
                <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-[var(--color-text-muted)]">
                  <span className={`rounded px-1.5 text-[11.5px] font-medium ${STATE_CLS[r.state]}`}>{STATE_LABEL[r.state]}</span>
                  {r.last ? <span>балл {fmtScore(r.last.scorePercent)} · {r.last.submittedAt ? fmtDay(r.last.submittedAt) : ''}</span>
                    : <span>до {fmtDayTime(r.dueAt)}</span>}
                  <span>{r.questionCount} вопр.{r.timeLimitMin ? ` · ${r.timeLimitMin} мин` : ''}</span>
                  {r.trainingTitle && <span className="min-w-0 truncate">обучение «{r.trainingTitle}»</span>}
                  {r.canStart && r.last && <span className="text-[var(--color-accent)]">пересдача разрешена</span>}
                </span>
              </span>
              <ChevronRight size={18} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
