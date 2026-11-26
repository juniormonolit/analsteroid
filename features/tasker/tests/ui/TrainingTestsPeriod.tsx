'use client';
import { useQuery } from '@tanstack/react-query';
import type { TrainingTestPeriodResponse } from '../types';
import { TESTS_KEY, getJson } from './api';
import { fmtDay, fmtScore, pctOf } from './format';

const TH = 'whitespace-nowrap px-3 py-2 text-left text-[12px] font-medium text-[var(--color-text-muted)]';
const TD = 'whitespace-nowrap px-3 py-2 tabular-nums';

/** «Эффективность» → обучения за период, по которым был тест: средний балл и доля сдавших (по видимым людям). */
export function TrainingTestsPeriod({ from, to }: { from: string; to: string }) {
  const q = useQuery({
    queryKey: [...TESTS_KEY, 'period', from, to],
    queryFn: () => getJson<TrainingTestPeriodResponse>(`/api/tasker/tests/period?from=${from}&to=${to}`),
    retry: false,
  });
  const rows = q.data?.rows ?? [];
  if (q.isError || !rows.length) return null;
  const done = rows.reduce((n, r) => n + r.completed, 0);
  const passed = rows.reduce((n, r) => n + r.passed, 0);
  const sum = rows.reduce((n, r) => n + (r.avgScore ?? 0) * r.completed, 0);

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
        <h2 className="text-[15px] font-semibold">Тесты по обучениям</h2>
        <span className="text-[12.5px] text-[var(--color-text-muted)]">прошли {done} · сдали {pctOf(passed, done)} · средний балл {fmtScore(done ? sum / done : null)}</span>
      </div>
      <div className="scroll-x rounded-xl border border-[var(--color-border)]">
        <table className="w-full min-w-[560px] text-sm">
          <thead><tr className="border-b border-[var(--color-border)]">
            <th className={TH}>Обучение</th><th className={TH}>Тест</th><th className={TH}>Назначено</th><th className={TH}>Прошли</th><th className={TH}>Сдали</th><th className={TH}>Ср. балл</th>
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.eventId} className="border-b border-[var(--color-border)] last:border-0">
                <td className="max-w-[260px] px-3 py-2"><span className="block truncate">{r.title}</span><span className="text-[12px] text-[var(--color-text-muted)]">{fmtDay(r.startsAt)}</span></td>
                <td className="max-w-[220px] truncate px-3 py-2">{r.testTitles.join(', ') || '—'}</td>
                <td className={TD}>{r.assigned}</td>
                <td className={TD}>{r.completed}</td>
                <td className={TD}>{pctOf(r.passed, r.completed)}</td>
                <td className={TD}>{fmtScore(r.avgScore)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
