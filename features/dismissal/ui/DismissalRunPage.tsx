'use client';

import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useDismissalRun } from './api';
import { DraftEditor } from './DraftEditor';
import { RunProgress } from './RunProgress';
import { fmtDateTime } from './planMath';
import { ErrorBox, RunStatusBadge, card, userHint } from './shared';

// Прогон «Увольнятора»: шапка + экран по статусу (сбор / черновик / исполнение).

export function DismissalRunPage({ id }: { id: string }) {
  const { data: run, isLoading, isError, error } = useDismissalRun(id);

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto max-w-[1100px] p-3 pb-24 sm:p-6">
        <Link href="/dismissal" className="mb-2 inline-flex min-h-11 items-center gap-1.5 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          <ArrowLeft size={16} /> Все увольнения
        </Link>

        {isLoading && <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">Загружаю…</div>}
        {isError && <ErrorBox>Не удалось загрузить прогон: {error.message}</ErrorBox>}

        {run && (
          <>
            <div className="mb-4">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 break-words text-lg font-semibold text-[var(--color-text)]">Увольнение: {run.source.name}</h1>
                <RunStatusBadge status={run.status} />
                {!run.source.active && <span className="text-xs text-[var(--color-text-muted)]">уволен в Битриксе</span>}
              </div>
              <p className="text-xs text-[var(--color-text-muted)] break-words">
                {userHint(run.source) && <>{userHint(run.source)} · </>}
                создал {run.createdByName}, {fmtDateTime(run.createdAt)}
              </p>
            </div>

            {run.status === 'scanning' && (
              <div className={`${card} flex flex-col items-center gap-3 px-4 py-12 text-center`}>
                <Loader2 size={28} className="animate-spin text-[var(--color-accent)]" />
                <div className="text-sm font-medium text-[var(--color-text)]">Собираю, что на аккаунте…</div>
                <div className="max-w-[440px] text-xs text-[var(--color-text-muted)]">
                  Прохожу сделки, лиды, контакты, компании, задачи и дела в Битриксе. Обычно это меньше минуты;
                  страницу можно не держать открытой.
                  {run.counts.total > 0 && <> Уже нашёл: {run.counts.total.toLocaleString('ru-RU')}.</>}
                </div>
              </div>
            )}

            {run.status === 'draft' && <DraftEditor key={run.id} run={run} />}

            {run.status !== 'scanning' && run.status !== 'draft' && <RunProgress run={run} />}
          </>
        )}
      </div>
    </div>
  );
}
