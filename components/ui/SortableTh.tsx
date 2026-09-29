'use client';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';

// Заголовок сортируемой колонки (задача #8126, находки 4, 18, 24): <button> внутри
// <th> — сортировка с клавиатуры, aria-sort для экранных дикторов, единое кольцо
// фокуса DS (2px --border-focus, отступ 2px).
export function SortableTh({ label, active, dir, onClick, align = 'left', title, className = '', sticky }: {
  label: ReactNode; active: boolean; dir: 'asc' | 'desc'; onClick: () => void;
  align?: 'left' | 'right'; title?: string; className?: string;
  /** Закрепить колонку слева (первая колонка таблицы). */
  sticky?: boolean;
}) {
  return (
    <th scope="col" aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`sticky top-0 ${sticky ? 'left-0 z-30' : 'z-20'} bg-[var(--color-table-header)] border-b border-[var(--color-border)] px-2 py-0 h-[34px] text-xs font-semibold text-[var(--color-text-muted)] whitespace-nowrap select-none ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>
      <button type="button" onClick={onClick} title={title}
        className={`focus-ring inline-flex items-center gap-1 rounded-sm hover:text-[var(--color-text)] ${active ? 'text-[var(--color-text)]' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        <span>{label}</span>
        {active ? (dir === 'asc' ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />) : <span className="w-3" aria-hidden />}
      </button>
    </th>
  );
}
