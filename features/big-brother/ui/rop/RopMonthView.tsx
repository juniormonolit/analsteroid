'use client';
// «Большой брат» → «РОПы» → «Месяц по РОПам» (собрание 26.11): строки — РОПы, колонки — действия (задачи, разборы,
// обучение, проверено) и результат команды (продажи, % плана, CR → бронь / продажа) с изменением к прошлому такому же
// периоду. Сортировка по любой колонке. Подробная сводка (задачи по сервисам, сроки, контроль, подчинённые) — в
// раскрывашке ниже: директору на первом экране она не нужна. GET /api/big-brother/rop/month?from&to → RopMonthResponse.
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SortableTh } from '@/components/ui/SortableTh';
import type { DeptMetrics, RopMonthResponse, RopMonthRow } from '../../engine/rop/types';
import { usePeriod } from './PeriodBar';
import { fmtInt, fmtMoney, fmtOne, fmtPct } from './format';

const one = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });

/** Изменение: продажи — в %, доли — в п.п. */
function delta(cur: number | null | undefined, prev: number | null | undefined, kind: 'rel' | 'pp'): number | null {
  if (cur == null || prev == null) return null;
  if (kind === 'pp') return (cur - prev) * 100;
  return prev > 0 ? ((cur - prev) / prev) * 100 : null;
}

function Delta({ v, unit }: { v: number | null; unit: '%' | 'п.п.' }) {
  if (v == null) return <span className="text-[var(--color-text-muted)]">—</span>;
  const cls = Math.abs(v) < 0.05 ? 'text-[var(--color-text-muted)]' : v > 0 ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]';
  return <span className={cls}>{one.format(v)} {unit}</span>;
}

interface Col {
  key: string; label: string; title?: string; group: 'act' | 'res';
  get: (r: RopMonthRow) => number | null;
  cell: (r: RopMonthRow) => ReactNode;
}

const salesD = (r: RopMonthRow) => delta(r.dept?.salesAmount, r.prev?.salesAmount, 'rel');
const ppD = (pick: (m: DeptMetrics) => number | null) => (r: RopMonthRow) => delta(r.dept ? pick(r.dept) : null, r.prev ? pick(r.prev) : null, 'pp');
const planD = ppD(m => m.planPct), resD = ppD(m => m.crReserve), crD = ppD(m => m.cr);

const COLS: Col[] = [
  { key: 'tasks', group: 'act', label: 'Задач', title: 'Поставлено задач за период: Задачник, большие чеки, повторка (через Монолитику и прямо в Битриксе)', get: r => r.tasks, cell: r => fmtInt(r.tasks) },
  { key: 'perSub', group: 'act', label: 'На подч.', title: 'Задач на одного подчинённого', get: r => r.tasksPerSub, cell: r => fmtOne(r.tasksPerSub) },
  { key: 'coverage', group: 'act', label: 'Охват', title: 'Доля подчинённых, получивших хоть одну задачу', get: r => r.coverage, cell: r => fmtPct(r.coverage) },
  { key: 'meetings', group: 'act', label: 'Разборов', title: 'Сессии Задачника и «Практики» один на один, слот уже наступил; в скобках — отмечено «Провёл»', get: r => r.meetings, cell: r => <>{fmtInt(r.meetings)}{r.meetingsHeld ? <span className="text-[var(--color-text-muted)]"> ({r.meetingsHeld})</span> : null}</> },
  { key: 'training', group: 'act', label: 'Обучение', title: 'Отправлено на обучение — задачи Задачника «Теория»', get: r => r.training, cell: r => fmtInt(r.training) },
  { key: 'accepted', group: 'act', label: 'Проверено', title: 'Закрыл поставленные им задачи сам + приёмки в канбане повторки', get: r => r.accepted, cell: r => fmtInt(r.accepted) },
  { key: 'sales', group: 'res', label: 'Продажи', title: 'Продажи команды (перв. + повт.), ₽: подчинённые + сам РОП', get: r => r.dept?.salesAmount ?? null, cell: r => fmtMoney(r.dept?.salesAmount) },
  { key: 'salesD', group: 'res', label: 'Δ', title: 'Изменение продаж к прошлому периоду, %', get: salesD, cell: r => <Delta v={salesD(r)} unit="%" /> },
  { key: 'plan', group: 'res', label: '% плана', get: r => r.dept?.planPct ?? null, cell: r => fmtPct(r.dept?.planPct) },
  { key: 'planD', group: 'res', label: 'Δ', title: 'Изменение выполнения плана, п.п.', get: planD, cell: r => <Delta v={planD(r)} unit="п.п." /> },
  { key: 'crRes', group: 'res', label: 'CR → бронь', title: 'CR Сделка → Бронь (все воронки)', get: r => r.dept?.crReserve ?? null, cell: r => fmtPct(r.dept?.crReserve) },
  { key: 'crResD', group: 'res', label: 'Δ', title: 'Изменение CR Сделка → Бронь, п.п.', get: resD, cell: r => <Delta v={resD(r)} unit="п.п." /> },
  { key: 'cr', group: 'res', label: 'CR → продажа', title: 'CR Сделка → Продажа (все воронки)', get: r => r.dept?.cr ?? null, cell: r => fmtPct(r.dept?.cr) },
  { key: 'crD', group: 'res', label: 'Δ', title: 'Изменение CR Сделка → Продажа, п.п.', get: crD, cell: r => <Delta v={crD(r)} unit="п.п." /> },
];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** Картина «действия × результат»: действия — задач на подчинённого против медианы РОПов, результат — Δ продаж. */
function picture(r: RopMonthRow, med: number): { text: string; tone: 'good' | 'bad' | 'mid' } | null {
  const d = salesD(r);
  if (r.tasksPerSub == null || d == null) return null;
  const active = r.tasksPerSub >= med;
  if (active && d >= 0) return { text: 'действует, рост', tone: 'good' };
  if (active) return { text: 'действует, без роста', tone: 'mid' };
  if (d >= 0) return { text: 'мало действий, рост', tone: 'mid' };
  return { text: 'мало действий, падение', tone: 'bad' };
}
const TONE = { good: 'bg-emerald-500/15 text-[var(--color-positive)]', mid: 'bg-amber-500/15 text-[var(--color-text)]', bad: 'bg-red-500/15 text-[var(--color-negative)]' };

export function RopMonthView({ details }: { details: ReactNode }) {
  const { from, to } = usePeriod();
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: 'salesD', desc: true });
  const [openDetails, setOpenDetails] = useState(false);
  const { data, error, isLoading, isFetching } = useQuery<RopMonthResponse, Error>({
    queryKey: ['big-brother-rop-month', from, to],
    queryFn: async () => {
      const r = await fetch(`/api/big-brother/rop/month?from=${from}&to=${to}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j as RopMonthResponse;
    },
    staleTime: 60_000,
    placeholderData: prev => prev,
  });

  const med = useMemo(() => median((data?.rows ?? []).map(r => r.tasksPerSub).filter((v): v is number => v != null)), [data]);
  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
    const col = COLS.find(c => c.key === sort.key);
    list.sort((a, b) => {
      if (sort.key === 'name') { const c = a.name.localeCompare(b.name, 'ru'); return sort.desc ? -c : c; }
      const x = col?.get(a) ?? -Infinity, y = col?.get(b) ?? -Infinity;
      return sort.desc ? y - x : x - y;
    });
    return list;
  }, [data, sort]);
  const onSort = (key: string) => setSort(s => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }));
  const groupTh = 'border-b border-[var(--color-border)] bg-[var(--color-table-header)] px-2 py-1 text-center text-xs font-semibold text-[var(--color-text-secondary)]';

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {data && (
        <p className="text-xs text-[var(--color-text-muted)]">
          Действия РОПа против результата его команды. Сравнение — с {fmtD(data.prevPeriod.from)}–{fmtD(data.prevPeriod.to)}.
          {isFetching && ' Обновляю…'}
        </p>
      )}
      {error && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{error.message}</div>}
      {isLoading && !data && !error && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Считаю действия и результаты команд (до 30 с)…</div>}
      {data && (rows.length === 0 ? (
        <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">В оргструктуре нет РОПов с подчинёнными.</div>
      ) : (
        <div className="scroll-x rounded-xl border border-[var(--color-border)]">
          <table className="w-full min-w-[1180px] text-sm">
            <thead>
              <tr>
                <th className={`${groupTh} sticky left-0 z-30`} />
                <th className={groupTh} />
                <th colSpan={COLS.filter(c => c.group === 'act').length} className={`${groupTh} border-l`}>Действия РОПа</th>
                <th colSpan={COLS.filter(c => c.group === 'res').length} className={`${groupTh} border-l`}>Результат команды и изменение</th>
              </tr>
              <tr>
                <SortableTh label="РОП" sticky active={sort.key === 'name'} dir={sort.desc ? 'desc' : 'asc'} onClick={() => onSort('name')} />
                <th scope="col" title="Действия (задач на подчинённого против медианы РОПов) × изменение продаж"
                  className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-table-header)] px-2 text-left text-xs font-semibold text-[var(--color-text-muted)]">Картина</th>
                {COLS.map(c => (
                  <SortableTh key={c.key} label={c.label} title={c.title} align="right" active={sort.key === c.key}
                    dir={sort.desc ? 'desc' : 'asc'} onClick={() => onSort(c.key)} />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const pic = picture(r, med);
                return (
                  <tr key={r.id} className="border-t border-[var(--color-border)]">
                    <td className="sticky left-0 z-10 bg-[var(--color-bg)] px-2 py-1 text-left">
                      <a href={`/big-brother/rop?rop=${r.id}`} title="Открыть «День РОПа»" className="flex min-h-11 min-w-0 flex-col justify-center">
                        <span className="font-medium text-[var(--color-accent)]">{r.name}</span>
                        <span className="max-w-[150px] truncate text-xs text-[var(--color-text-muted)] sm:max-w-[220px]">
                          {[r.deptNames.join(', '), `${r.subordinates} подч.`].filter(Boolean).join(' · ')}
                        </span>
                      </a>
                    </td>
                    <td className="px-2 py-1">
                      {pic ? <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${TONE[pic.tone]}`}>{pic.text}</span> : <span className="text-[var(--color-text-muted)]">—</span>}
                    </td>
                    {COLS.map(c => (
                      <td key={c.key} className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-[var(--color-text)]">{c.cell(r)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {data && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--color-text-muted)]">
          {data.notes.map(n => <li key={n}>{n}</li>)}
          {med > 0 && <li>«Картина»: действует — задач на подчинённого не меньше медианы РОПов ({fmtOne(med)}); рост — продажи команды не ниже прошлого периода.</li>}
        </ul>
      )}
      <details className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3"
        onToggle={e => setOpenDetails((e.target as HTMLDetailsElement).open)}>
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-[var(--color-text)]">
          Подробная сводка: задачи по сервисам, сроки, контроль, подчинённые
        </summary>
        <div className="pb-3">{openDetails && details}</div>
      </details>
    </div>
  );
}

const fmtD = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
