'use client';
// «Большой брат» → «РОПы»: рейтинг РОПов по постановке задач (Задачник / большие чеки / повторка) против показателей
// отдела. GET /api/big-brother/rop?from&to → RopRatingResponse. Таблица с сортировкой, разворот РОПа до подчинённых,
// scatter «задачи × показатели». Доступ — только админы (гейт на странице и в API).
import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { SortableTh } from '@/components/ui/SortableTh';
import type { RopRatingResponse, RopRow, RopSubordinate } from '../../engine/rop/types';
import { PeriodBar, usePeriod } from './PeriodBar';
import { RopScatter } from './RopScatter';
import { fmtDate, fmtInt, fmtMoney, fmtOne, fmtPct } from './format';

interface Col {
  key: string; label: string; title?: string;
  get: (r: RopRow) => number | string | null;
  fmt?: (r: RopRow) => string;
  sub?: (s: RopSubordinate) => string;
  /** Подсветить слабое значение красным. */
  bad?: (r: RopRow) => boolean;
}

const COLS: Col[] = [
  { key: 'subordinates', label: 'Подч.', title: 'Подчинённых-продавцов по оргструктуре (на сегодня)', get: r => r.subordinates },
  { key: 'tasks', label: 'Задач', title: 'Поставлено задач за период во всех трёх сервисах', get: r => r.tasks, sub: s => fmtInt(s.tasks) },
  { key: 'perSub', label: 'На подч.', title: 'Задач на одного подчинённого', get: r => r.tasksPerSub, fmt: r => fmtOne(r.tasksPerSub) },
  { key: 'tasker', label: 'Задачник', get: r => r.byService.tasker, sub: s => fmtInt(s.byService.tasker) },
  { key: 'big', label: 'Большие', title: 'Задачи, созданные РОПом в проектах больших сделок', get: r => r.byService.big, sub: s => fmtInt(s.byService.big) },
  { key: 'repeat', label: 'Повторка', get: r => r.byService.repeat, sub: s => fmtInt(s.byService.repeat) },
  { key: 'direct', label: 'В Битриксе', title: 'Из них поставлено руками в Битриксе (не через Монолитику)', get: r => r.direct },
  { key: 'days', label: 'Дней', title: 'Дней с постановкой задач / рабочих дней периода', get: r => r.activeDays, fmt: r => `${r.activeDays} / ${r.workdays}` },
  { key: 'gaps', label: 'Провалы', title: 'Рабочих недель без единой задачи / всего недель', get: r => r.gapWeeks, fmt: r => `${r.gapWeeks} / ${r.weeks}`, bad: r => r.weeks > 0 && r.gapWeeks > 0 },
  { key: 'coverage', label: 'Охват', title: 'Доля подчинённых, получивших хоть одну задачу', get: r => r.coverage, fmt: r => fmtPct(r.coverage), bad: r => r.coverage != null && r.coverage < 0.5, sub: s => (s.lastTaskAt ? `посл. ${fmtDate(s.lastTaskAt)}` : 'без задач') },
  { key: 'closed', label: 'Закрыто', title: 'Задач из поставленных за период уже закрыто', get: r => r.follow.closed, sub: s => fmtInt(s.closed) },
  { key: 'waiting', label: 'Ждут контроля', title: 'Сданы исполнителем, ждут проверки РОПа', get: r => r.follow.waitingControl },
  { key: 'accepted', label: 'Проверено', title: 'Закрыты самим РОПом в Битриксе + приняты в канбане повторки', get: r => r.follow.accepted },
  { key: 'overdue', label: 'Просрочено', title: 'Открыты и просрочены сейчас', get: r => r.follow.overdueOpen, bad: r => r.follow.overdueOpen > 0, sub: s => fmtInt(s.overdueOpen) },
  { key: 'returned', label: 'Возвраты', title: 'Вернул на доработку в канбане повторки', get: r => r.follow.returned },
  { key: 'improved', label: 'Показатель вырос', title: 'Задачник: доля задач с вердиктом автозамера «достигнут / вырос» среди замеренных', get: r => r.taskerImprovedPct, fmt: r => (r.taskerImprovedPct == null ? '—' : `${fmtPct(r.taskerImprovedPct)} из ${r.follow.taskerMeasured}`) },
  { key: 'sales', label: 'Продажи', title: 'Продажи отдела (перв. + повт.), ₽', get: r => r.dept?.salesAmount ?? null, fmt: r => fmtMoney(r.dept?.salesAmount), sub: s => fmtMoney(s.metrics?.salesAmount) },
  { key: 'plan', label: 'План', title: 'Выполнение плана продаж отдела за период', get: r => r.dept?.planPct ?? null, fmt: r => fmtPct(r.dept?.planPct), bad: r => r.dept?.planPct != null && r.dept.planPct < 0.8, sub: s => fmtPct(s.metrics?.planPct) },
  { key: 'cr', label: 'CR', title: 'CR Сделка → Продажа (все воронки)', get: r => r.dept?.cr ?? null, fmt: r => fmtPct(r.dept?.cr), sub: s => fmtPct(s.metrics?.cr) },
  { key: 'check', label: 'Ср. чек', get: r => r.dept?.avgCheck ?? null, fmt: r => fmtMoney(r.dept?.avgCheck), sub: s => fmtMoney(s.metrics?.avgCheck) },
];

function Weekly({ r, max }: { r: RopRow; max: number }) {
  return (
    <span className="inline-flex h-5 items-end gap-px" aria-label={`По неделям: ${r.weekly.join(', ')}`}>
      {r.weekly.map((n, i) => (
        <span key={i} title={`${n}`} className={`w-1.5 rounded-sm ${n ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-negative)] opacity-60'}`}
          style={{ height: `${n ? Math.max(15, (n / max) * 100) : 12}%` }} />
      ))}
    </span>
  );
}

export function RopRatingPage() {
  const { from, to } = usePeriod();
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: 'tasks', desc: true });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { data, error, isLoading, isFetching } = useQuery<RopRatingResponse, Error>({
    queryKey: ['big-brother-rop', from, to],
    queryFn: async () => {
      const r = await fetch(`/api/big-brother/rop?from=${from}&to=${to}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j as RopRatingResponse;
    },
    staleTime: 60_000,
    placeholderData: prev => prev,
  });

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
    const col = COLS.find(c => c.key === sort.key);
    list.sort((a, b) => {
      if (sort.key === 'name') { const c = a.name.localeCompare(b.name, 'ru'); return sort.desc ? -c : c; }
      const x = col?.get(a), y = col?.get(b);
      const xn = typeof x === 'number' ? x : -Infinity, yn = typeof y === 'number' ? y : -Infinity;
      return sort.desc ? yn - xn : xn - yn;
    });
    return list;
  }, [data, sort]);
  const maxWeek = useMemo(() => Math.max(1, ...(data?.rows ?? []).flatMap(r => r.weekly)), [data]);
  const toggle = (id: string) => setOpen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const onSort = (key: string) => setSort(s => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }));

  return (
    <div className="flex min-w-0 flex-col gap-3 px-4 pb-6 pt-3 sm:px-6">
      <PeriodBar>
        <p className="min-w-0 basis-full text-xs text-[var(--color-text-muted)] sm:basis-auto">
          Задачи по дате постановки (МСК). Отдел — подчинённые РОПа + он сам.{isFetching && data && ' Обновляю…'}
        </p>
      </PeriodBar>

      {error && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{error.message}</div>}
      {isLoading && !data && !error && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Считаю задачи и показатели отделов…</div>}
      {data && (rows.length === 0 ? (
        <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">В оргструктуре нет РОПов с подчинёнными.</div>
      ) : (
        <>
          <div className="scroll-x rounded-xl border border-[var(--color-border)]">
            <table className="w-full min-w-[1400px] text-sm">
              <thead>
                <tr>
                  <SortableTh label="РОП" sticky active={sort.key === 'name'} dir={sort.desc ? 'desc' : 'asc'} onClick={() => onSort('name')} />
                  <th scope="col" title="Задач по неделям периода; красное — неделя без задач"
                    className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-table-header)] px-2 text-xs font-semibold text-[var(--color-text-muted)]">Недели</th>
                  {COLS.map(c => (
                    <SortableTh key={c.key} label={c.label} title={c.title} align="right" active={sort.key === c.key}
                      dir={sort.desc ? 'desc' : 'asc'} onClick={() => onSort(c.key)} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const isOpen = open.has(r.id);
                  return (
                    <Fragment key={r.id}>
                      <tr className="border-t border-[var(--color-border)]">
                        <td className="sticky left-0 z-10 bg-[var(--color-bg)] px-2 py-1 text-left">
                          <button type="button" onClick={() => toggle(r.id)} aria-expanded={isOpen}
                            className="flex min-h-11 items-center gap-1 text-left text-[var(--color-text)]">
                            {isOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                            <span className="flex min-w-0 flex-col">
                              <span className="font-medium">{r.name}</span>
                              <span className="max-w-[150px] truncate sm:max-w-[220px] text-xs text-[var(--color-text-muted)]">{[r.branch, ...r.deptNames].filter(Boolean).join(' · ')}</span>
                            </span>
                          </button>
                        </td>
                        <td className="px-2 py-1"><Weekly r={r} max={maxWeek} /></td>
                        {COLS.map(c => (
                          <td key={c.key} className={`whitespace-nowrap px-2 py-1 text-right tabular-nums ${c.bad?.(r) ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-text)]'}`}>
                            {c.fmt ? c.fmt(r) : fmtInt(c.get(r) as number | null)}
                          </td>
                        ))}
                      </tr>
                      {isOpen && r.subs.map(s => (
                        <tr key={`${r.id}:${s.id}`} className="bg-[var(--color-bg-surface)] text-xs">
                          <td className="sticky left-0 z-10 bg-[var(--color-bg-surface)] py-1 pl-8 pr-2 text-left">
                            <div className="text-[var(--color-text)]">{s.name}</div>
                            {s.deptName && <div className="max-w-[150px] truncate sm:max-w-[200px] text-[var(--color-text-muted)]">{s.deptName}</div>}
                          </td>
                          <td />
                          {COLS.map(c => (
                            <td key={c.key} className={`whitespace-nowrap px-2 py-1 text-right tabular-nums ${c.key === 'coverage' && !s.tasks ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`}>
                              {c.sub ? c.sub(s) : ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <RopScatter rows={rows} />
          <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--color-text-muted)]">
            {data.notes.map(n => <li key={n}>{n}</li>)}
          </ul>
        </>
      ))}
    </div>
  );
}
