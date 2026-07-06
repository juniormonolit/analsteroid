'use client';
import { Fragment } from 'react';
import { MONTHS, grandTotal, groups, type DecompRow } from '../data';

function fmt(n: number) {
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

const CELL = 'px-3 py-1.5 text-right text-xs tabular-nums whitespace-nowrap border-r border-[var(--color-border)]';
const YEAR_CELL = `${CELL} font-semibold`;

function DataRow({ row, variant }: { row: DecompRow; variant: 'dept' | 'city' | 'grand' }) {
  const rowCls =
    variant === 'grand'
      ? 'bg-[var(--color-accent)]/10 font-bold text-[var(--color-text)]'
      : variant === 'city'
        ? 'bg-[var(--color-bg-surface)] font-semibold text-[var(--color-text)]'
        : 'hover:bg-[var(--color-bg-hover)] text-[var(--color-text)]';

  return (
    <tr className={`border-b border-[var(--color-border)] ${rowCls}`}>
      <td className="sticky left-0 z-10 px-3 py-1.5 text-sm text-left border-r border-[var(--color-border)] min-w-[220px] bg-inherit">
        {row.label}
      </td>
      <td className={YEAR_CELL}>{fmt(row.year)}</td>
      {row.months.map((v, i) => (
        <td key={i} className={CELL}>{fmt(v)}</td>
      ))}
    </tr>
  );
}

export function DecompositionPage() {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-2.5 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex items-baseline gap-3">
        <h1 className="text-sm font-semibold text-[var(--color-text)]">Декомпозиция</h1>
        <span className="text-xs text-[var(--color-text-muted)]">Планы по отгрузкам</span>
      </div>

      <div className="overflow-auto flex-1">
        <table className="border-collapse text-sm">
          <thead className="sticky top-0 z-20">
            <tr className="bg-[var(--color-bg-surface)] border-b border-[var(--color-border)]">
              <th className="sticky left-0 z-30 bg-[var(--color-bg-surface)] px-3 py-2 min-w-[220px] text-left text-xs font-semibold text-[var(--color-text-muted)] border-r border-[var(--color-border)]" />
              <th className="px-3 py-2 text-right text-xs font-semibold text-[var(--color-text-muted)] border-r border-[var(--color-border)] whitespace-nowrap">За год</th>
              {MONTHS.map(m => (
                <th key={m} className="px-3 py-2 text-right text-xs font-semibold text-[var(--color-text-muted)] border-r border-[var(--color-border)] whitespace-nowrap">
                  {m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <DataRow row={grandTotal} variant="grand" />
            {groups.map(group => (
              <Fragment key={group.city}>
                <tr>
                  <td colSpan={2 + MONTHS.length} className="h-3" />
                </tr>
                {group.rows.map(row => (
                  <DataRow key={row.label} row={row} variant="dept" />
                ))}
                <DataRow row={group.total} variant="city" />
              </Fragment>
            ))}
          </tbody>
        </table>

        <p className="px-6 py-4 text-xs text-[var(--color-text-muted)] max-w-3xl">
          По МСК отдел «НЦ (металл)» входит в состав «НЦ» и учтён в строке «МСК (НЦ)».
        </p>
      </div>
    </div>
  );
}
