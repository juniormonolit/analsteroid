'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
import { useDismissalRun, useRunCommand } from './api';
import { DraftEditor } from './DraftEditor';
import { RunProgress } from './RunProgress';
import { fmtDateTime } from './planMath';
import { ErrorBox, RunStatusBadge, Skeleton, btnPrimary, btnSecondary, card, runErrors, userHint } from './shared';

// Прогон «Увольнятора»: шапка + экран по статусу (сбор / упавший сбор / черновик / исполнение).

export function DismissalRunPage({ id }: { id: string }) {
  const { data: run, isLoading, isError, error, refetch } = useDismissalRun(id);
  const existing = useSearchParams().get('existing') === '1';
  const isDraft = run?.status === 'draft';
  const scanFailed = run?.status === 'failed' && !run.startedAt;
  const draftDeleted = run?.status === 'cancelled' && !run.startedAt;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      {/* у черновика внизу липкая панель — большой нижний отступ не нужен */}
      <div className={`mx-auto max-w-[1100px] p-3 sm:p-6 ${isDraft ? 'pb-3 sm:pb-3' : 'pb-24'}`}>
        <Link href="/dismissal" className="mb-2 inline-flex min-h-11 items-center gap-1.5 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          <ArrowLeft size={16} /> Все увольнения
        </Link>

        {isLoading && (
          <div className="flex flex-col gap-3"><Skeleton className="h-16" /><Skeleton className="h-40" /><Skeleton className="h-64" /></div>
        )}
        {isError && <ErrorBox onRetry={() => void refetch()}>Не удалось загрузить прогон: {error.message}</ErrorBox>}

        {run && (
          <>
            <div className="mb-3">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 break-words text-lg font-semibold text-[var(--color-text)]">Увольнение: {run.source.name}</h1>
                <RunStatusBadge status={run.status} errors={runErrors(run)} />
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
                  Прохожу повторные и первичные сделки, задачи и дела в Битриксе. Контакты, компании и дела сделки
                  Битрикс переведёт сам вместе со сделкой. Обычно это меньше минуты; страницу можно не держать открытой.
                  {run.counts.total > 0 && <> Уже нашёл: {run.counts.total.toLocaleString('ru-RU')}.</>}
                </div>
              </div>
            )}

            {scanFailed && <ScanFailed id={run.id} error={run.error} />}

            {draftDeleted && (
              <div className={`${card} flex flex-col items-center gap-3 px-4 py-10 text-center`}>
                <div className="text-sm font-medium text-[var(--color-text)]">Черновик удалён — в Битриксе ничего не менялось.</div>
                <Link href="/dismissal" className={btnSecondary}>К списку</Link>
              </div>
            )}

            {isDraft && <DraftEditor key={run.id} run={run} existing={existing} />}

            {!isDraft && run.status !== 'scanning' && !scanFailed && !draftDeleted && <RunProgress run={run} />}
          </>
        )}
      </div>
    </div>
  );
}

function ScanFailed({ id, error }: { id: string; error: string | null }) {
  const cmd = useRunCommand(id);
  return (
    <div className={`${card} flex flex-col gap-3 p-4`}>
      <div className="text-sm font-semibold text-[var(--color-text)]">Не удалось собрать данные из Битрикса</div>
      <ErrorBox>{error || 'Сбор прервался без описания ошибки.'}</ErrorBox>
      <p className="text-xs text-[var(--color-text-muted)]">В Битриксе ничего не менялось. Обычно помогает собрать заново через минуту.</p>
      {cmd.isError && <ErrorBox>{cmd.error.message}</ErrorBox>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" className={btnPrimary} disabled={cmd.isPending} onClick={() => cmd.mutate('rescan')}>
          <RefreshCw size={14} className={cmd.isPending ? 'animate-spin' : ''} /> Собрать заново
        </button>
        <Link href="/dismissal" className={btnSecondary}>К списку</Link>
      </div>
    </div>
  );
}
