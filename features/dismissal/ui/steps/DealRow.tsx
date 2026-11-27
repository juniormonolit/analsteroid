'use client';

import type { DismissalItem } from '../../types';
import { fmtRub } from '../planMath';
import { RowCheck, TitleText, rowCls } from '../ItemRow';

// Строка-сделка первички (шаги 3–4): на ≥xl — grid колонками, ниже — карточка.

export const DEAL_GRID_Q = 'xl:grid xl:grid-cols-[28px_minmax(0,1fr)_120px_150px_240px] xl:items-center xl:gap-3';
export const DEAL_GRID_N = 'xl:grid xl:grid-cols-[28px_minmax(0,1fr)_120px_280px] xl:items-center xl:gap-3';

export function DealHeader({ grid, cols }: { grid: string; cols: string[] }) {
  return (
    <div className={`sticky top-0 z-10 hidden border-b border-[var(--color-border)] bg-[var(--color-table-header)] px-3 py-2 text-[11px] uppercase tracking-wide text-[var(--color-text-muted)] ${grid}`}>
      <span />{cols.map((c, i) => <span key={c} className={i === 1 ? 'text-right' : ''}>{c}</span>)}
    </div>
  );
}

export const amountText = (it: DismissalItem) => (it.info?.amount ? fmtRub(it.info.amount) : '—');

export function DealRow({ item, grid, focused, selected, onToggle, onFocus, badge, last }: {
  item: DismissalItem;
  grid: string;
  focused: boolean;
  selected: boolean;
  onToggle: (shift: boolean) => void;
  onFocus: () => void;
  /** Ячейка причины (только шаг 3) */
  badge?: React.ReactNode;
  last: React.ReactNode;
}) {
  return (
    <li data-row-key={item.key} onClick={onFocus}
      className={`flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 ${grid} ${rowCls(focused, selected)}`}>
      <RowCheck checked={selected} onToggle={onToggle} label={`Выбрать ${item.title}`} />
      <div className="min-w-0 flex-1 basis-[calc(100%-40px)] xl:basis-auto">
        <div className="text-sm"><TitleText item={item} /></div>
        {/* стадия — на любой ширине, под названием (как у заказчика повторки) */}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--color-text-muted)]">
          <span className="min-w-0 break-words">{item.info?.stageName ?? 'стадия не определена'}</span>
          <SoldBadge item={item} />
        </div>
      </div>
      <span className="hidden text-right text-sm tabular-nums xl:block">{amountText(item)}</span>
      {badge !== undefined && <span className="hidden xl:block">{badge}</span>}
      <div className="flex w-full flex-wrap items-center gap-x-2 pl-8 text-xs text-[var(--color-text-muted)] xl:hidden">
        <span className="tabular-nums">{amountText(item)}</span>{badge}
      </div>
      <div className="w-full min-w-0 pl-8 xl:w-auto xl:pl-0" onClick={e => e.stopPropagation()}>{last}</div>
    </li>
  );
}

export function ReasonBadge({ reason }: { reason?: string }) {
  if (!reason) return null;
  const short = reason.replace(/чек\s*≥\s*100\s*000/i, 'чек ≥ 100 тыс.');
  return <span className="inline-block rounded-full bg-[var(--color-positive)]/15 px-2 py-0.5 text-[11px] text-[var(--color-positive)]">{short}</span>;
}

/** «Продано, не отгружено»: стадия-продажа (event_type sold), а сделка ещё открыта. Старые черновики без поля — без бейджа. */
export function SoldBadge({ item }: { item: DismissalItem }) {
  if (item.info?.stageEvent !== 'sold') return null;
  return <span className="inline-block rounded-full bg-[var(--color-warning)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--color-warning)]">Продано · не отгружено</span>;
}
