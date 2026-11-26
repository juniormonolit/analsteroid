'use client';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePlus2, ListChecks } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import type { TaskerMetric } from '../../types';
import type { TestResponse, TestSaveRequest, TestStatus, TestSummary, TestsListResponse } from '../types';
import { TESTS_KEY, createTest, getJson, saveTest } from './api';
import { BTN_PRIMARY, fmtScore, pctOf } from './format';
import { TestEditor } from './TestEditor';
import { TestAssign, TestResults } from './TestResults';

type Pane = 'edit' | 'assign' | 'results';
const STATUS_LABEL: Record<TestStatus, string> = { draft: 'Черновик', published: 'Опубликован', archived: 'Архив' };
const subTab = (on: boolean) => `inline-flex min-h-11 items-center border-b-2 px-2.5 text-sm ${on ? 'border-[var(--color-accent)] font-medium text-[var(--color-accent)]' : 'border-transparent text-[var(--color-text-secondary)]'}`;

/**
 * Вкладка «Тесты» на /tasker/trainings (TASKER_SPEC «Тесты»): тренер создаёт и публикует тесты, назначает, смотрит
 * результаты; РОП — назначает опубликованные своим и видит их результаты. Менеджер проходит в ЛК (/profile/tests).
 */
export function TestsView({ metrics }: { metrics: TaskerMetric[] }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: TESTS_KEY, queryFn: () => getJson<TestsListResponse>('/api/tasker/tests') });
  const [openId, setOpenId] = useState<number | null>(null);
  const [pane, setPane] = useState<Pane>('results');
  const [showArchived, setShowArchived] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canManage = q.data?.canManage ?? false;

  // ?test=ID — ссылка прямо на тест.
  useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get('test'));
    if (Number.isInteger(id) && id > 0) setOpenId(id);
  }, []);

  const tests = useMemo(() => (q.data?.tests ?? []).filter(t => showArchived || t.status !== 'archived'), [q.data, showArchived]);
  const archivedCount = (q.data?.tests ?? []).filter(t => t.status === 'archived').length;
  const current = (q.data?.tests ?? []).find(t => t.id === openId) ?? null;
  const full = useQuery({
    queryKey: [...TESTS_KEY, 'full', openId],
    queryFn: () => getJson<TestResponse>(`/api/tasker/tests/${openId}`),
    enabled: canManage && openId !== null,
  });

  const mut = useMutation({
    mutationFn: (fn: () => Promise<TestResponse>) => fn(),
    onMutate: () => setErr(null),
    onSuccess: r => {
      qc.setQueryData([...TESTS_KEY, 'full', r.test.id], r);
      qc.invalidateQueries({ queryKey: TESTS_KEY });
    },
    onError: (e: Error) => setErr(e.message),
  });
  const create = () => mut.mutate(async () => {
    const r = await createTest({ title: 'Новый тест' });
    setOpenId(r.test.id); setPane('edit');
    return r;
  });
  const open = (t: TestSummary) => { setErr(null); setOpenId(t.id); setPane(canManage && t.status === 'draft' ? 'edit' : 'results'); };
  const save = (req: TestSaveRequest) => { if (openId) mut.mutate(() => saveTest(openId, req)); };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] text-[var(--color-text-muted)]">
          {canManage
            ? 'Тест по материалам обучения: назначьте вручную или привяжите к занятию — всем отмеченным «был» он уйдёт через N дней. Менеджеры проходят в ЛК, вы видите баллы.'
            : 'Назначайте опубликованные тесты своим менеджерам и смотрите их результаты.'}
        </p>
        {canManage && (
          <button type="button" onClick={create} disabled={mut.isPending} className={BTN_PRIMARY}>
            <FilePlus2 size={16} aria-hidden /> Новый тест
          </button>
        )}
      </div>
      {archivedCount > 0 && (
        <label className="inline-flex min-h-11 items-center gap-2 self-start text-[13px] text-[var(--color-text-secondary)]">
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
          показать архив ({archivedCount})
        </label>
      )}
      {err && !openId && <p className="text-sm text-[var(--color-negative)]">{err}</p>}

      {q.isLoading ? <div className="h-16 animate-pulse rounded-xl bg-[var(--color-bg-surface)]" aria-busy />
        : q.isError ? <p className="text-sm text-[var(--color-negative)]">{(q.error as Error).message}</p>
        : tests.length === 0 ? (
          <div className="flex min-w-0 flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
            <ListChecks size={22} aria-hidden />
            {canManage ? 'Тестов пока нет. Создайте первый — например, по кровле или фасаду.' : 'Опубликованных тестов пока нет.'}
          </div>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2">
            {tests.map(t => (
              <li key={t.id}>
                <button type="button" onClick={() => open(t)}
                  className={`flex w-full min-w-0 flex-col gap-1 rounded-xl border border-[var(--color-border)] px-3 py-3 text-left hover:bg-[var(--color-bg-hover)] sm:flex-row sm:items-center sm:gap-4 ${t.status === 'archived' ? 'opacity-60' : ''}`}>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="min-w-0 break-words font-medium">{t.title}</span>
                    <span className="flex min-w-0 flex-wrap gap-x-3 text-[12.5px] text-[var(--color-text-muted)]">
                      <span>{STATUS_LABEL[t.status]}{t.version ? ` · v${t.version}` : ''}{t.hasUnpublished && t.status === 'published' ? ' · есть правки' : ''}</span>
                      <span>{t.questionCount} вопр.</span>
                      <span>порог {t.passPercent}%</span>
                      {t.timeLimitMin && <span>{t.timeLimitMin} мин</span>}
                      {t.isCertification && <span className="text-[var(--color-accent)]">аттестационный</span>}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-3 text-[12.5px] tabular-nums text-[var(--color-text-secondary)]">
                    <span>назначено {t.assigned}</span>
                    <span>прошли {t.completed}</span>
                    <span>сдали {pctOf(t.passed, t.completed)}</span>
                    <span>ср. {fmtScore(t.avgScore)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

      <Drawer open={openId !== null} onOpenChange={o => { if (!o) { setOpenId(null); setErr(null); } }}
        title={current?.title ?? full.data?.test.title ?? 'Тест'} desktopWidth="sm:max-w-[760px]">
        {openId !== null && (
          <div className="flex min-w-0 flex-col gap-3">
            <div role="tablist" aria-label="Тест" className="flex flex-wrap gap-x-1 border-b border-[var(--color-border)]">
              {(canManage ? (['edit', 'assign', 'results'] as const) : (['assign', 'results'] as const)).map(p => (
                <button key={p} type="button" role="tab" aria-selected={pane === p} onClick={() => setPane(p)} className={subTab(pane === p)}>
                  {p === 'edit' ? 'Вопросы' : p === 'assign' ? 'Назначить' : 'Результаты'}
                </button>
              ))}
            </div>
            {pane === 'edit' && canManage && (full.data
              ? <TestEditor key={`${full.data.test.id}-${full.data.test.updatedAt}`} test={full.data.test} metrics={metrics} busy={mut.isPending} error={err} onSave={save} />
              : <p className="text-sm text-[var(--color-text-muted)]">{full.isError ? (full.error as Error).message : 'Загружаю…'}</p>)}
            {pane === 'assign' && (current ?? full.data?.test) && <TestAssign test={(current ?? full.data?.test)!} />}
            {pane === 'results' && <TestResults testId={openId} canManage={canManage} />}
          </div>
        )}
      </Drawer>
    </div>
  );
}
