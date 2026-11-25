'use client';
// «Большой брат» → «Задачи»: дисциплина задач по сотрудникам (продажи + логисты). GET /api/big-brother/tasks →
// DisciplineResponse. Директор видит свой срез, админ — всех (срез режет API).
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SortableTh } from '@/components/ui/SortableTh';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import type { DisciplineResponse, DisciplineRow } from '../../engine/tasks/types';
import { PeriodBar, usePeriod } from '../rop/PeriodBar';
import { fmtInt, fmtPct } from '../rop/format';

type NumKey = Exclude<keyof DisciplineRow, 'id' | 'name' | 'deptName' | 'ropName' | 'kind'>;
const COLS: { key: NumKey; label: string; title?: string; bad?: (r: DisciplineRow) => boolean; pct?: boolean }[] = [
  { key: 'received', label: 'Получено', title: 'Задач поставлено на сотрудника за период' },
  { key: 'closed', label: 'Закрыто', title: 'Закрыто за период' },
  { key: 'onTime', label: 'Вовремя', title: 'Закрыто до последнего срока задачи' },
  { key: 'late', label: 'С опозданием', title: 'Закрыто позже последнего срока', bad: r => r.late > 0 },
  { key: 'onTimePct', label: '% вовремя', title: 'Вовремя / (вовремя + с опозданием)', pct: true, bad: r => r.onTimePct != null && r.onTimePct < 0.7 },
  { key: 'noDeadline', label: 'Без срока', title: 'Закрыто за период, срока не было' },
  { key: 'open', label: 'Открыто', title: 'Открыто сейчас (не начата / в работе / отложена)' },
  { key: 'overdue', label: 'Просрочено', title: 'Открыто и просрочено сейчас', bad: r => r.overdue > 0 },
  { key: 'stale', label: 'Без движения', title: 'Открыто, без единого изменения дольше N дней', bad: r => r.stale > 0 },
  { key: 'waitingControl', label: 'Ждёт контроля', title: 'Сдано, ждёт проверки постановщика' },
  { key: 'returned', label: 'Возвращено', title: 'Возвращено на доработку за период' },
];
const KIND_LABEL = { sales: 'Продажи', logist: 'Логист', other: '—' } as const;
const STALE_OPTS = [3, 5, 7, 14, 30].map(n => ({ value: String(n), label: `Без движения ${n} дн.` }));
const SCOPE_OPTS = [{ value: 'all', label: 'Все задачи сотрудника' }, { value: 'services', label: 'Только Задачник, большие, повторка' }];
const KIND_OPTS = [{ value: '', label: 'Продажи и логисты' }, { value: 'sales', label: 'Продажи' }, { value: 'logist', label: 'Логисты' }];

export function TaskDisciplinePage() {
  const { from, to } = usePeriod();
  const [scope, setScope] = useUrlState('scope', stringParam('all'));
  const [stale, setStale] = useUrlState('stale', stringParam('7'));
  const [kind, setKind] = useUrlState('kind', stringParam(''));
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: NumKey | 'name'; desc: boolean }>({ key: 'overdue', desc: true });

  const { data, error, isLoading, isFetching } = useQuery<DisciplineResponse, Error>({
    queryKey: ['big-brother-tasks', from, to, scope, stale],
    queryFn: async () => {
      const r = await fetch(`/api/big-brother/tasks?from=${from}&to=${to}&scope=${scope}&stale=${stale}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j as DisciplineResponse;
    },
    staleTime: 60_000,
    placeholderData: prev => prev,
  });

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (data?.rows ?? []).filter(r => (!kind || r.kind === kind)
      && (!needle || `${r.name} ${r.deptName ?? ''} ${r.ropName ?? ''}`.toLowerCase().includes(needle)));
    list.sort((a, b) => {
      if (sort.key === 'name') { const c = a.name.localeCompare(b.name, 'ru'); return sort.desc ? -c : c; }
      const x = a[sort.key] ?? -1, y = b[sort.key] ?? -1;
      return sort.desc ? y - x : x - y;
    });
    return list;
  }, [data, sort, kind, q]);
  const onSort = (key: NumKey | 'name') => setSort(s => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }));

  return (
    <div className="flex min-w-0 flex-col gap-3 px-4 pb-6 pt-3 sm:px-6">
      <PeriodBar>
        <SearchSelect ariaLabel="Какие задачи" options={SCOPE_OPTS} value={scope} onChange={setScope} className="min-h-11 max-w-full" />
        <SearchSelect ariaLabel="Порог без движения" options={STALE_OPTS} value={stale} onChange={setStale} className="min-h-11 max-w-full" />
        <SearchSelect ariaLabel="Кто" options={KIND_OPTS} value={kind} onChange={setKind} className="min-h-11 max-w-full" />
        <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск: сотрудник, отдел, РОП"
          className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] sm:w-64 sm:text-sm" />
      </PeriodBar>
      <p className="text-xs text-[var(--color-text-muted)]">
        Закрытия и полученные — за период; «сейчас» — на момент открытия страницы.{isFetching && data && ' Обновляю…'}
      </p>

      {error && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{error.message}</div>}
      {isLoading && !data && !error && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Считаю задачи…</div>}
      {data && (rows.length === 0 ? (
        <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Нет сотрудников с задачами за период.</div>
      ) : (
        <div className="scroll-x rounded-xl border border-[var(--color-border)]">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr>
                <SortableTh label="Сотрудник" sticky active={sort.key === 'name'} dir={sort.desc ? 'desc' : 'asc'} onClick={() => onSort('name')} />
                {COLS.map(c => (
                  <SortableTh key={c.key} label={c.label} title={c.title} align="right" active={sort.key === c.key}
                    dir={sort.desc ? 'desc' : 'asc'} onClick={() => onSort(c.key)} />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-t border-[var(--color-border)]">
                  <td className="sticky left-0 z-10 bg-[var(--color-bg)] px-2 py-1.5 text-left">
                    <div className="font-medium text-[var(--color-text)]">{r.name}</div>
                    <div className="max-w-[150px] truncate sm:max-w-[240px] text-xs text-[var(--color-text-muted)]">
                      {[KIND_LABEL[r.kind], r.deptName, r.ropName && `РОП ${r.ropName}`].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  {COLS.map(c => (
                    <td key={c.key} className={`px-2 py-1.5 text-right tabular-nums ${c.bad?.(r) ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-text)]'}`}>
                      {c.pct ? fmtPct(r[c.key]) : fmtInt(r[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[var(--color-border-strong)] bg-[var(--color-bg-surface)] font-semibold">
                <td className="sticky left-0 z-10 bg-[var(--color-bg-surface)] px-2 py-1.5 text-left text-[var(--color-text)]">Итого (все в срезе)</td>
                {COLS.map(c => (
                  <td key={c.key} className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text)]">
                    {c.pct ? fmtPct(data.total.onTimePct) : fmtInt(data.total[c.key as Exclude<NumKey, 'onTimePct'>])}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      ))}
      {data && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--color-text-muted)]">
          {data.notes.map(n => <li key={n}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}
