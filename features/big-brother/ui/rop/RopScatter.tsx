'use client';
// Scatter «задачи РОПа × показатели отдела»: точка — РОП. Оси выбираются (SearchSelect, без нативных select).
import { useMemo, useState } from 'react';
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { SearchSelect } from '@/components/ui/SearchSelect';
import type { RopRow } from '../../engine/rop/types';
import { fmtMoney, fmtOne, fmtPct } from './format';

type Fmt = (v: number | null) => string;
interface Axis { value: string; label: string; get: (r: RopRow) => number | null; fmt: Fmt; pct?: boolean }

const X_AXES: Axis[] = [
  { value: 'perSub', label: 'Задач на подчинённого', get: r => r.tasksPerSub, fmt: fmtOne },
  { value: 'tasks', label: 'Задач всего', get: r => r.tasks, fmt: fmtOne },
  { value: 'coverage', label: 'Охват подчинённых', get: r => r.coverage, fmt: fmtPct, pct: true },
  { value: 'activeDays', label: 'Дней с постановкой', get: r => r.activeDays, fmt: fmtOne },
];
const Y_AXES: Axis[] = [
  { value: 'planPct', label: 'Выполнение плана', get: r => r.dept?.planPct ?? null, fmt: fmtPct, pct: true },
  { value: 'cr', label: 'CR Сделка → Продажа', get: r => r.dept?.cr ?? null, fmt: fmtPct, pct: true },
  { value: 'salesPerSub', label: 'Продажи на человека', get: r => (r.dept && r.subordinates ? r.dept.salesAmount / (r.subordinates + 1) : null), fmt: fmtMoney },
  { value: 'avgCheck', label: 'Средний чек', get: r => r.dept?.avgCheck ?? null, fmt: fmtMoney },
];

interface Pt { x: number; y: number; name: string }

export function RopScatter({ rows }: { rows: RopRow[] }) {
  const [xk, setX] = useState('perSub');
  const [yk, setY] = useState('planPct');
  const xa = X_AXES.find(a => a.value === xk)!;
  const ya = Y_AXES.find(a => a.value === yk)!;
  const pts = useMemo(() => rows.flatMap((r): Pt[] => {
    const x = xa.get(r), y = ya.get(r);
    return x == null || y == null ? [] : [{ x: xa.pct ? x * 100 : x, y: ya.pct ? y * 100 : y, name: r.name }];
  }), [rows, xa, ya]);

  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--color-border)] p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-[var(--color-text)]">Задачи РОПа × показатели отдела</span>
        <SearchSelect ariaLabel="Ось X" options={X_AXES} value={xk} onChange={setX} className="min-h-11 max-w-full" />
        <span className="text-[var(--color-text-muted)]">×</span>
        <SearchSelect ariaLabel="Ось Y" options={Y_AXES} value={yk} onChange={setY} className="min-h-11 max-w-full" />
      </div>
      {pts.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Нет РОПов с обоими значениями.</p>
      ) : (
        <div className="h-72 w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
              <XAxis type="number" dataKey="x" name={xa.label} tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
                tickFormatter={v => (xa.pct ? `${v}%` : fmtOne(v))} />
              <YAxis type="number" dataKey="y" name={ya.label} width={56} tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
                tickFormatter={v => (ya.pct ? `${v}%` : ya.fmt(v))} />
              <Tooltip cursor={{ strokeDasharray: '4 4' }} content={({ payload }) => {
                const p = payload?.[0]?.payload as Pt | undefined;
                if (!p) return null;
                return (
                  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs shadow">
                    <div className="font-semibold text-[var(--color-text)]">{p.name}</div>
                    <div className="text-[var(--color-text-muted)]">{xa.label}: {xa.pct ? `${fmtOne(p.x)}%` : xa.fmt(p.x)}</div>
                    <div className="text-[var(--color-text-muted)]">{ya.label}: {ya.pct ? `${fmtOne(p.y)}%` : ya.fmt(p.y)}</div>
                  </div>
                );
              }} />
              <ZAxis range={[48, 48]} />
              <Scatter data={pts} fill="var(--color-accent)" />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
