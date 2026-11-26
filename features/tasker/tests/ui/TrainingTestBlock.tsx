'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import type { TestsListResponse, TrainingTestStatsResponse } from '../types';
import { TESTS_KEY, assignTrainingNow, getJson, setTrainingTest } from './api';
import { BTN, INPUT, fmtScore, pctOf } from './format';

/**
 * Блок «Тест» в карточке обучения: тренер выбирает тест и через сколько дней после занятия он уйдёт всем отмеченным
 * «был» (по умолчанию 7, срок 3 дня), может назначить сразу. Всем — средний балл и доля сдавших по своим людям.
 */
export function TrainingTestBlock({ eventId, canManage, cancelled }: { eventId: number; canManage: boolean; cancelled: boolean }) {
  const qc = useQueryClient();
  const statsKey = [...TESTS_KEY, 'training', eventId];
  const stats = useQuery({
    queryKey: statsKey,
    queryFn: () => getJson<TrainingTestStatsResponse>(`/api/tasker/tests/training?eventIds=${eventId}`),
    retry: false,
  });
  const tests = useQuery({
    queryKey: TESTS_KEY,
    queryFn: () => getJson<TestsListResponse>('/api/tasker/tests'),
    enabled: canManage,
  });
  const s = stats.data?.stats[0];
  const [testId, setTestId] = useState('');
  const [after, setAfter] = useState(7);
  const [due, setDue] = useState(3);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (s?.link) { setTestId(String(s.link.testId)); setAfter(s.link.afterDays); setDue(s.link.dueDays); }
  }, [s?.link]);

  const mut = useMutation({
    mutationFn: (fn: () => Promise<string>) => fn(),
    onMutate: () => setMsg(null),
    onSuccess: m => { setMsg(m); qc.invalidateQueries({ queryKey: TESTS_KEY }); },
    onError: (e: Error) => setMsg(e.message),
  });

  if (stats.isError || (!canManage && !s?.link && !s?.assigned)) return null;
  const options = [{ value: '', label: 'Без теста' }, ...(tests.data?.tests ?? []).filter(t => t.status === 'published').map(t => ({ value: String(t.id), label: t.title }))];
  const dirty = !s?.link ? !!testId : String(s.link.testId) !== testId || s.link.afterDays !== after || s.link.dueDays !== due;

  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold"><ListChecks size={15} /> Тест по материалам</h3>
      {s && s.assigned > 0 && (
        <p className="text-[12.5px] text-[var(--color-text-secondary)]">
          Назначено {s.assigned} · прошли {s.completed} · сдали {pctOf(s.passed, s.completed)} · средний балл {fmtScore(s.avgScore)}
        </p>
      )}
      {!canManage ? (
        s?.link && <p className="text-[12.5px] text-[var(--color-text-muted)]">«{s.link.testTitle}» — через {s.link.afterDays} дн. после занятия всем, кто был.</p>
      ) : cancelled ? null : (
        <>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
            <SearchSelect options={options} value={testId} onChange={setTestId} searchable ariaLabel="Тест к обучению"
              placeholder={tests.isLoading ? 'Загружаю…' : 'Выберите тест'} className="min-h-11 w-full min-w-0" />
            <label className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-secondary)]">
              через
              <input type="number" min={0} max={60} inputMode="numeric" value={after} onChange={e => setAfter(Number(e.target.value) || 0)} className={`${INPUT} w-20`} aria-label="Через сколько дней после занятия" />
              дн.
            </label>
            <label className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-secondary)]">
              срок
              <input type="number" min={1} max={30} inputMode="numeric" value={due} onChange={e => setDue(Number(e.target.value) || 1)} className={`${INPUT} w-20`} aria-label="Срок прохождения, дней" />
              дн.
            </label>
          </div>
          <p className="text-[12px] text-[var(--color-text-muted)]">Уйдёт автоматически всем, кого вы отметили «был», когда пройдёт указанное число дней после занятия.</p>
          <div className="flex flex-wrap gap-2">
            {dirty && (
              <button type="button" disabled={mut.isPending} className={BTN}
                onClick={() => mut.mutate(async () => { await setTrainingTest(eventId, { testId: testId ? Number(testId) : null, afterDays: after, dueDays: due }); return testId ? 'Тест привязан к обучению' : 'Тест отвязан'; })}>
                Сохранить
              </button>
            )}
            {s?.link && !dirty && (
              <button type="button" disabled={mut.isPending} className={BTN}
                onClick={() => mut.mutate(async () => { const r = await assignTrainingNow(eventId); return `Назначено сейчас: ${r.created}${r.skipped ? `, пропущено ${r.skipped}` : ''}`; })}>
                Назначить сейчас
              </button>
            )}
          </div>
        </>
      )}
      {msg && <p className="text-[12.5px] text-[var(--color-text-secondary)]">{msg}</p>}
    </section>
  );
}
