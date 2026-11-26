'use client';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, X } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { TestAssignOptionsResponse, TestAssignmentRow, TestResultsResponse, TestSummary } from '../types';
import { TESTS_KEY, allowRetake, assignTest, cancelAssignment, getJson } from './api';
import { BTN_PRIMARY, INPUT, STATE_CLS, STATE_LABEL, fmtDay, fmtScore, pctOf } from './format';

/** Назначить тест вручную: менеджеры и/или отделы (РОП — только свои), срок. */
export function TestAssign({ test }: { test: TestSummary }) {
  const qc = useQueryClient();
  const opts = useQuery({
    queryKey: [...TESTS_KEY, 'options'],
    queryFn: () => getJson<TestAssignOptionsResponse>('/api/tasker/tests/options'),
    staleTime: 5 * 60_000,
  });
  const [managers, setManagers] = useState<string[]>([]);
  const [depts, setDepts] = useState<string[]>([]);
  const [dueDays, setDueDays] = useState(3);
  const [msg, setMsg] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () => assignTest(test.id, { managerIds: managers.map(Number), departmentIds: depts, dueDays }),
    onMutate: () => setMsg(null),
    onSuccess: r => {
      setMsg(`Назначено: ${r.created}${r.skipped ? ` · пропущено ${r.skipped} (тест уже висит непройденным)` : ''}. Менеджерам ушло сообщение от «Аналитика».`);
      setManagers([]); setDepts([]);
      qc.invalidateQueries({ queryKey: TESTS_KEY });
    },
    onError: (e: Error) => setMsg(e.message),
  });
  if (test.status !== 'published') return <p className="text-sm text-[var(--color-text-muted)]">Назначить можно после публикации теста.</p>;
  const mOptions = (opts.data?.managers ?? []).map(m => ({ value: String(m.id), label: m.name, hint: m.departmentName }));
  const dOptions = (opts.data?.departments ?? []).map(d => ({ value: d.id, label: d.name, hint: d.path }));

  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm">
      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-[12.5px] text-[var(--color-text-secondary)]">Менеджеры</span>
        <SearchMultiSelect options={mOptions} value={managers} onChange={setManagers} allLabel={opts.isLoading ? 'Загружаю…' : 'Не выбраны'}
          unitLabel="менеджеров" searchPlaceholder="Поиск по имени или отделу" ariaLabel="Менеджеры" className="min-h-11 w-full min-w-0" />
      </label>
      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-[12.5px] text-[var(--color-text-secondary)]">Или целым отделом</span>
        <SearchMultiSelect options={dOptions} value={depts} onChange={setDepts} allLabel="Не выбраны" unitLabel="отделов"
          searchPlaceholder="Поиск отдела" ariaLabel="Отделы" className="min-h-11 w-full min-w-0" />
      </label>
      <label className="flex min-w-0 flex-col gap-1 sm:max-w-[200px]">
        <span className="text-[12.5px] text-[var(--color-text-secondary)]">Срок, дней</span>
        <input type="number" min={1} max={30} inputMode="numeric" value={dueDays} onChange={e => setDueDays(Number(e.target.value) || 1)} className={INPUT} />
      </label>
      <button type="button" disabled={mut.isPending || (!managers.length && !depts.length)} onClick={() => mut.mutate()} className={`${BTN_PRIMARY} self-start`}>
        {mut.isPending ? 'Назначаю…' : 'Назначить'}
      </button>
      {msg && <p className="text-[13px] text-[var(--color-text-secondary)]">{msg}</p>}
    </div>
  );
}

/** Результаты теста: сводка, самые трудные вопросы, таблица назначений (тренер — все, РОП — свои). */
export function TestResults({ testId, canManage }: { testId: number; canManage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: [...TESTS_KEY, 'results', testId],
    queryFn: () => getJson<TestResultsResponse>(`/api/tasker/tests/${testId}/results`),
  });
  const [filter, setFilter] = useState('');
  const [confirm, setConfirm] = useState<TestAssignmentRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onMutate: () => setErr(null),
    onSuccess: () => { setConfirm(null); qc.invalidateQueries({ queryKey: TESTS_KEY }); },
    onError: (e: Error) => setErr(e.message),
  });
  const rows = useMemo(() => (q.data?.rows ?? []).filter(r => !filter || r.state === filter), [q.data, filter]);
  if (q.isLoading) return <p className="text-sm text-[var(--color-text-muted)]">Загружаю…</p>;
  if (q.isError) return <p className="text-sm text-[var(--color-negative)]">{(q.error as Error).message}</p>;
  const d = q.data!;
  const active = d.rows.filter(r => r.state !== 'cancelled');
  const done = active.filter(r => r.last);

  return (
    <div className="flex min-w-0 flex-col gap-4 text-sm">
      {d.scope === 'own' && <p className="text-[12.5px] text-[var(--color-text-muted)]">Показаны ваши менеджеры.</p>}
      <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi label="Назначено" value={String(active.length)} />
        <Kpi label="Прошли" value={`${done.length}`} hint={pctOf(done.length, active.length)} />
        <Kpi label="Сдали" value={pctOf(done.filter(r => r.last?.passed).length, done.length)} hint={`порог ${d.test.passPercent}%`} />
        <Kpi label="Средний балл" value={fmtScore(done.length ? done.reduce((s, r) => s + (r.last?.scorePercent ?? 0), 0) / done.length : null)} />
      </div>

      {d.hardest.length > 0 && (
        <section className="flex min-w-0 flex-col gap-1.5">
          <h3 className="font-semibold">Самые трудные вопросы</h3>
          <ol className="flex min-w-0 flex-col gap-1">
            {d.hardest.slice(0, 5).map(h => (
              <li key={h.questionId} className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 tabular-nums text-[var(--color-negative)]">{pctOf(h.wrong, h.answered)}</span>
                <span className="min-w-0 break-words">{h.text || '—'}</span>
                <span className="ml-auto shrink-0 text-[12px] text-[var(--color-text-muted)]">{h.wrong}/{h.answered}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="font-semibold">Кто проходит</h3>
          <SearchSelect value={filter} onChange={setFilter} ariaLabel="Фильтр по статусу" className="min-h-11 ml-auto min-w-[160px]"
            options={[{ value: '', label: 'Все статусы' }, ...(['assigned', 'in_progress', 'passed', 'failed', 'overdue', 'cancelled'] as const).map(s => ({ value: s, label: STATE_LABEL[s] }))]} />
        </div>
        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        {rows.length === 0 ? <p className="text-[var(--color-text-muted)]">Пока никого.</p> : (
          <ul className="flex min-w-0 flex-col gap-1.5">
            {rows.map(r => (
              <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--color-border)] px-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="min-w-0 truncate font-medium">{r.manager.name}</span>
                  <span className="min-w-0 truncate text-[12px] text-[var(--color-text-muted)]">
                    {r.departmentName ?? '—'} · до {fmtDay(r.dueAt)}{r.trainingTitle ? ` · обучение «${r.trainingTitle}»` : ''}
                  </span>
                </span>
                <span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${STATE_CLS[r.state]}`}>{STATE_LABEL[r.state]}</span>
                <span className="w-12 text-right tabular-nums">{r.last ? fmtScore(r.last.scorePercent) : ''}</span>
                {r.attempts.length > 1 && <span className="text-[12px] text-[var(--color-text-muted)]">попыток: {r.attempts.filter(a => a.submittedAt).length}</span>}
                <span className="flex items-center gap-1">
                  {r.canRetake && (
                    <button type="button" disabled={mut.isPending} onClick={() => mut.mutate(() => allowRetake(r.id))}
                      className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-[13px] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
                      <RotateCcw size={14} aria-hidden /> Пересдача
                    </button>
                  )}
                  {r.state !== 'cancelled' && !r.last && (
                    <button type="button" aria-label="Снять назначение" onClick={() => setConfirm(r)}
                      className="tap-target inline-flex size-9 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X size={16} /></button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ConfirmDialog open={!!confirm} title="Снять назначение?" description={confirm ? `${confirm.manager.name} больше не увидит этот тест в ЛК.` : ''}
        confirmLabel="Снять" cancelLabel="Оставить" tone="danger" pending={mut.isPending}
        onCancel={() => setConfirm(null)} onConfirm={() => { if (confirm) mut.mutate(() => cancelAssignment(confirm.id)); }} />
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl bg-[var(--color-bg-surface)] px-3 py-2">
      <span className="text-[12px] text-[var(--color-text-muted)]">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-[11.5px] text-[var(--color-text-muted)]">{hint}</span>}
    </div>
  );
}
