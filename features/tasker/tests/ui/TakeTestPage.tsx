'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Clock, X } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { MyTestDetailResponse, TakeAttempt } from '../types';
import { MY_TESTS_KEY, getJson, myTestAction } from './api';
import { BTN_PRIMARY, STATE_CLS, STATE_LABEL, fmtDayTime, fmtScore } from './format';

/**
 * Прохождение теста в ЛК (/profile/tests/<назначение>) — в первую очередь с телефона: вопросы карточками, крупные
 * варианты (вся строка — зона нажатия), липкая панель с прогрессом, таймером и «Отправить». Ответы автосохраняются;
 * по таймеру тест отправляется сам. После — балл, сдал/не сдал и номера вопросов с ошибкой (без правильных ответов).
 */
export function TakeTestPage({ id }: { id: number }) {
  const qc = useQueryClient();
  const key = [...MY_TESTS_KEY, 'one', id];
  const q = useQuery({ queryKey: key, queryFn: () => getJson<MyTestDetailResponse>(`/api/tasker/tests/my/${id}`), retry: false });
  const [err, setErr] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: (fn: () => Promise<MyTestDetailResponse>) => fn(),
    onMutate: () => setErr(null),
    onSuccess: r => { qc.setQueryData(key, r); qc.invalidateQueries({ queryKey: MY_TESTS_KEY, exact: true }); },
    // Ошибка (например, время вышло и попытку уже закрыли) — перечитываем состояние.
    onError: (e: Error) => { setErr(e.message); qc.invalidateQueries({ queryKey: key }); },
  });

  const back = (
    <Link href="/profile/tests" className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm text-[var(--color-accent)]">
      <ArrowLeft size={16} aria-hidden /> Все тесты
    </Link>
  );
  if (q.isLoading) return <div className="mx-auto w-full max-w-[760px] p-3 sm:p-5">{back}<div className="mt-2 h-32 animate-pulse rounded-xl bg-[var(--color-bg-surface)]" /></div>;
  if (q.isError) return <div className="mx-auto flex w-full max-w-[760px] flex-col gap-2 p-3 sm:p-5">{back}<p className="text-sm text-[var(--color-negative)]">{(q.error as Error).message}</p></div>;
  const d = q.data!;
  const r = d.row;

  return (
    <div className="mx-auto flex w-full max-w-[760px] min-w-0 flex-col gap-4 p-3 pb-0 sm:p-5 sm:pb-0">
      {back}
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="break-words text-xl font-extrabold text-[var(--color-text)]">{r.testTitle}</h1>
        <p className="flex min-w-0 flex-wrap gap-x-3 text-[13px] text-[var(--color-text-muted)]">
          <span className={`rounded px-1.5 text-[12px] font-medium ${STATE_CLS[r.state]}`}>{STATE_LABEL[r.state]}</span>
          <span>{r.questionCount} вопр.</span>
          <span>проходной {r.passPercent}%</span>
          {r.timeLimitMin && <span>на всё {r.timeLimitMin} мин</span>}
          {!r.last && <span>до {fmtDayTime(r.dueAt)}</span>}
        </p>
      </header>

      {d.attempt ? (
        <Attempt key={d.attempt.id} assignmentId={id} attempt={d.attempt} busy={mut.isPending} error={err}
          onSubmit={answers => mut.mutate(() => myTestAction(id, 'submit', answers))} />
      ) : (
        <>
          {d.review && r.last && <Review d={d} />}
          {r.canStart ? (
            <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 text-sm">
              {r.description && <p className="whitespace-pre-wrap break-words">{r.description}</p>}
              <ul className="list-disc pl-5 text-[var(--color-text-secondary)]">
                <li>Попытка {r.last ? 'пересдачи' : ''} одна — начните, когда будет 10–15 спокойных минут.</li>
                {r.timeLimitMin ? <li>После «Начать» пойдёт таймер на {r.timeLimitMin} мин; по его окончании ответы отправятся сами.</li>
                  : <li>Ответы сохраняются по ходу — можно закрыть и вернуться.</li>}
                <li>После отправки увидите балл и вопросы с ошибкой.</li>
              </ul>
              {err && <p className="text-[var(--color-negative)]">{err}</p>}
              <button type="button" disabled={mut.isPending} onClick={() => mut.mutate(() => myTestAction(id, 'start'))} className={`${BTN_PRIMARY} w-full sm:w-auto sm:self-start`}>
                {mut.isPending ? 'Открываю…' : r.last ? 'Начать пересдачу' : 'Начать тест'}
              </button>
            </section>
          ) : !r.last && <p className="text-sm text-[var(--color-text-muted)]">Тест недоступен.</p>}
        </>
      )}
    </div>
  );
}

function Review({ d }: { d: MyTestDetailResponse }) {
  const last = d.row.last!;
  const review = d.review ?? [];
  const wrong = review.filter(x => !x.correct);
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className={`flex min-w-0 flex-col gap-1 rounded-xl border p-4 ${last.passed ? 'border-[var(--color-positive)]' : 'border-[var(--color-negative)]'}`}>
        <span className="text-3xl font-extrabold tabular-nums">{fmtScore(last.scorePercent)}</span>
        <span className={`font-semibold ${last.passed ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>
          {last.passed ? 'Тест сдан' : `Не сдан — нужно ${d.row.passPercent}%`}
        </span>
        <span className="text-[13px] text-[var(--color-text-muted)]">
          Верно {last.correct} из {last.total}{last.autoSubmitted ? ' · отправлено по таймеру' : ''}{last.submittedAt ? ` · ${fmtDayTime(last.submittedAt)}` : ''}
        </span>
      </div>
      {wrong.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="text-[15px] font-semibold">Где ошибка</h2>
          <p className="text-[12.5px] text-[var(--color-text-muted)]">Правильные ответы не показываем — разберите эти темы с тренером или по материалам обучения.</p>
          <ul className="flex min-w-0 flex-col gap-1.5">
            {review.map(x => (
              <li key={x.n} className="flex min-w-0 items-start gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm">
                {x.correct ? <Check size={16} className="mt-0.5 shrink-0 text-[var(--color-positive)]" aria-label="верно" />
                  : <X size={16} className="mt-0.5 shrink-0 text-[var(--color-negative)]" aria-label="ошибка" />}
                <span className="min-w-0 break-words"><b className="tabular-nums">{x.n}.</b> {x.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function useCountdown(deadline: string | null): number | null {
  const [left, setLeft] = useState<number | null>(deadline ? new Date(deadline).getTime() - Date.now() : null);
  useEffect(() => {
    if (!deadline) return;
    const t = setInterval(() => setLeft(new Date(deadline).getTime() - Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadline]);
  return left;
}
const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function Attempt({ assignmentId, attempt, busy, error, onSubmit }: {
  assignmentId: number; attempt: TakeAttempt; busy: boolean; error: string | null;
  onSubmit: (answers: Record<string, string[]>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>(attempt.answers ?? {});
  const [confirm, setConfirm] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const dirty = useRef(false);
  const latest = useRef(answers);
  latest.current = answers;
  const submitted = useRef(false);
  const left = useCountdown(attempt.deadlineAt);
  const answered = attempt.questions.filter(q => (answers[q.id] ?? []).length > 0).length;

  // Отправка не удалась (сеть) — даём нажать ещё раз.
  useEffect(() => { if (error) submitted.current = false; }, [error]);

  const submit = useCallback(() => {
    if (submitted.current) return;
    submitted.current = true;
    onSubmit(latest.current);
  }, [onSubmit]);

  // Автосохранение: через 1.5 с после последнего ответа.
  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(async () => {
      setSaveState('saving');
      try { await myTestAction(assignmentId, 'save', latest.current); dirty.current = false; setSaveState('saved'); }
      catch { setSaveState('error'); }
    }, 1500);
    return () => clearTimeout(t);
  }, [answers, assignmentId]);

  // Время вышло — отправляем сами.
  useEffect(() => { if (left !== null && left <= 0) submit(); }, [left, submit]);

  const toggle = (qid: string, oid: string, multi: boolean) => {
    dirty.current = true;
    setAnswers(a => {
      const cur = a[qid] ?? [];
      const next = multi ? (cur.includes(oid) ? cur.filter(x => x !== oid) : [...cur, oid]) : [oid];
      return { ...a, [qid]: next };
    });
  };

  return (
    <>
      <ol className="flex min-w-0 flex-col gap-3">
        {attempt.questions.map((q, i) => {
          const multi = q.kind === 'multi';
          const cur = answers[q.id] ?? [];
          return (
            <li key={q.id} className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 sm:p-4">
              <p className="break-words text-[15px] font-medium leading-snug"><span className="tabular-nums text-[var(--color-text-muted)]">{i + 1}.</span> {q.text}</p>
              {q.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={q.imageUrl} alt="" loading="lazy" className="max-h-72 max-w-full self-start rounded-lg border border-[var(--color-border)] object-contain" />
              )}
              <span className="text-[12px] text-[var(--color-text-muted)]">{multi ? 'Выберите все верные' : 'Выберите один ответ'}</span>
              <div className="flex min-w-0 flex-col gap-1.5" role={multi ? 'group' : 'radiogroup'} aria-label={`Вопрос ${i + 1}`}>
                {q.options.map(o => {
                  const on = cur.includes(o.id);
                  return (
                    <label key={o.id}
                      className={`flex min-h-12 min-w-0 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-[15px] ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/8' : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>
                      <input type={multi ? 'checkbox' : 'radio'} name={`q-${q.id}`} checked={on} onChange={() => toggle(q.id, o.id, multi)}
                        className="size-5 shrink-0 accent-[var(--color-accent)]" />
                      <span className="min-w-0 break-words">{o.text}</span>
                    </label>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>
      {error && <p className="text-sm text-[var(--color-negative)]">{error}</p>}

      {/* Липкая панель внизу прокрутки ЛК: прогресс, таймер, отправка. safe-area — под «домашнюю» полоску iPhone (PWA). */}
      <div className="sticky bottom-0 z-10 -mx-3 border-t border-[var(--color-border)] bg-[var(--color-bg)]/95 backdrop-blur sm:-mx-5" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex w-full min-w-0 items-center gap-3 px-3 py-2 sm:px-5">
          <span className="flex min-w-0 flex-1 flex-col text-[13px]">
            <span className="tabular-nums">Отвечено {answered} из {attempt.questions.length}</span>
            <span className="text-[11.5px] text-[var(--color-text-muted)]">
              {saveState === 'saving' ? 'Сохраняю…' : saveState === 'saved' ? 'Ответы сохранены' : saveState === 'error' ? 'Не сохранилось — проверьте связь' : ' '}
            </span>
          </span>
          {left !== null && (
            <span className={`inline-flex items-center gap-1 tabular-nums text-sm font-semibold ${left < 60_000 ? 'text-[var(--color-negative)]' : ''}`}>
              <Clock size={15} aria-hidden /> {mmss(left)}
            </span>
          )}
          <button type="button" disabled={busy} onClick={() => (answered < attempt.questions.length ? setConfirm(true) : submit())} className={BTN_PRIMARY}>
            {busy ? 'Отправляю…' : 'Отправить'}
          </button>
        </div>
      </div>
      <ConfirmDialog open={confirm} title="Отправить с пропусками?"
        description={`Без ответа ${attempt.questions.length - answered} из ${attempt.questions.length} — они засчитаются как ошибка. Попытка одна.`}
        confirmLabel="Отправить" cancelLabel="Вернуться" pending={busy}
        onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); submit(); }} />
    </>
  );
}
