'use client';
// «Сегодня» колонками (владелец 18.11: вертикальные секции не понравились — «как в повторке»): секция = колонка на всю
// высоту, карточки листаются внутри, доска — горизонтально. Стандартные слева в порядке сервера, «Свои колонки» —
// отдельной группой справа с плиткой «+ Своя колонка».
import { useState } from 'react';
import { CheckSquare, MoreHorizontal, SlidersHorizontal } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import type { BigTaskCard, BigTodaySection } from '../engine/types';
import { BigTaskCardView } from './BigTaskCardView';
import { AddColumnTile, MAX_CUSTOM_COLUMNS } from './CustomColumnModal';
import { describeFilters } from './filters';
import { moneyShort } from './format';

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

export interface SelectApi { has: (id: number) => boolean; toggle: (c: BigTaskCard) => void; addAll: (cs: BigTaskCard[]) => void }
export interface MenuItem { label: string; onClick: () => void; danger?: boolean }

/** Меню «⋯» в шапке колонки. */
export function ColumnMenu({ items, className = '' }: { items: MenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <Popover open={open} onOpenChange={setOpen} align="end" className="w-64 max-w-[calc(100vw-16px)] p-1" trigger={
      <button type="button" aria-label="Действия с колонкой" title="Действия с колонкой"
        className={`tap-target inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-black/10 ${className}`}>
        <MoreHorizontal size={16} aria-hidden />
      </button>
    }>
      {items.map(i => (
        <button key={i.label} type="button" onClick={() => { setOpen(false); i.onClick(); }}
          className={`flex min-h-11 w-full items-center rounded-md px-2 text-left text-sm hover:bg-[var(--color-bg-hover)] ${i.danger ? 'text-[var(--color-negative)]' : 'text-[var(--color-text)]'}`}>
          {i.label}
        </button>
      ))}
    </Popover>
  );
}

/** «Выбрать показанные · N» под шапкой колонки в режиме выделения. */
export function SelectAllButton({ cards, select }: { cards: BigTaskCard[]; select: SelectApi }) {
  if (!cards.length) return null;
  const all = cards.every(c => select.has(c.id));
  return (
    <button type="button" onClick={() => select.addAll(cards)} disabled={all}
      className="inline-flex min-h-9 items-center gap-1 text-xs text-[var(--color-accent)] hover:underline disabled:text-[var(--color-text-muted)] disabled:no-underline">
      <CheckSquare size={13} aria-hidden />{all ? 'Все показанные выбраны' : `Выбрать показанные · ${rub.format(cards.length)}`}
    </button>
  );
}

const TONE: Record<string, string> = {
  control: '#e69138', almost_sold: '#0070bf', new: '#00c4fb', stuck: 'var(--color-negative)',
  lost_check: '#ff5752', related_answered: '#6aa84f',
};

export function TodayColumns({ sections, groups, onOpen, select, custom, menuFor }: {
  sections: BigTodaySection[];
  groups: { id: number; short: string }[];
  onOpen: (c: BigTaskCard) => void;
  select: SelectApi | null;
  /** Свои колонки (null — недоступно, например моковые без API). */
  custom: { onAdd: () => void; onEdit: (sec: BigTodaySection) => void } | null;
  /** Пункты меню «⋯» секции (массовое закрытие по правилу и т.п.). */
  menuFor: (sec: BigTodaySection) => MenuItem[];
}) {
  const std = sections.filter(s => !s.custom);
  const mine = sections.filter(s => s.custom);

  const renderSec = (sec: BigTodaySection) => {
    const isCustom = !!sec.custom;
    const menu = [...(isCustom && custom ? [{ label: 'Изменить условия / удалить', onClick: () => custom.onEdit(sec) }] : []), ...menuFor(sec)];
    const hint = isCustom ? (sec.hint || describeFilters(sec.custom!.filters, groups)) : sec.hint;
    return (
      <section key={sec.key} data-today={sec.key} className="flex h-full w-80 max-w-[85vw] shrink-0 flex-col gap-2 rounded-xl bg-[var(--color-bg-surface)] p-2">
        <div className={isCustom
          ? 'rounded-lg border border-dashed border-[color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[var(--color-bg)] px-2 py-1.5'
          : 'rounded-lg px-2 py-1.5'}
          style={isCustom ? undefined : { borderLeft: `3px solid ${TONE[sec.key] ?? 'var(--color-accent)'}` }} title={hint}>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <h2 className="flex min-w-0 items-center gap-1 text-sm font-semibold text-[var(--color-text)]">
              {isCustom && <SlidersHorizontal size={13} className="shrink-0 text-[var(--color-accent)]" aria-hidden />}
              <span className="truncate">{sec.title}</span>
            </h2>
            <span className="flex shrink-0 items-center gap-1 text-[var(--color-text-muted)]">
              <span className="text-sm tabular-nums">{rub.format(sec.total)}</span>
              <ColumnMenu items={menu} className="hover:bg-[var(--color-bg-hover)]" />
            </span>
          </div>
          <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs text-[var(--color-text-muted)]">
            <span className="line-clamp-2 min-w-0">{hint}</span>
            {sec.sum > 0 && <span className="shrink-0 tabular-nums">{moneyShort(sec.sum)}</span>}
          </div>
          {select && <SelectAllButton cards={sec.cards} select={select} />}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden">
          {sec.cards.map(c => (
            <BigTaskCardView key={`${sec.key}:${c.id}`} card={c} onOpen={onOpen}
              selected={select ? select.has(c.id) : null} onSelect={select ? () => select.toggle(c) : undefined} />
          ))}
          {sec.total === 0 && <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">{isCustom ? 'Сейчас ничего не подходит.' : 'Пусто — всё разобрано.'}</div>}
          {sec.total > sec.cards.length && (
            <div className="px-2 py-2 text-xs text-[var(--color-text-muted)]">Показаны первые {sec.cards.length} из {rub.format(sec.total)} — уточните фильтр</div>
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="relative min-h-[75dvh] min-w-0 flex-1 px-4 pb-4 pt-3 sm:min-h-0 sm:px-6">
      <div className="scroll-x h-full">
        <div className="flex h-full items-stretch gap-3">
          {std.length > 0 && (
            <div className="flex h-full shrink-0 flex-col gap-2">
              {custom && <div className="sticky left-0 w-max px-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Стандартные</div>}
              <div className="flex min-h-0 flex-1 items-stretch gap-3">{std.map(renderSec)}</div>
            </div>
          )}
          {/* Свои колонки — отдельной группой, пунктир слева (как в повторке). */}
          {(custom || mine.length > 0) && (
            <div className="ml-1 flex h-full shrink-0 flex-col gap-2 border-l border-dashed border-[var(--color-border)] pl-4 sm:ml-2 sm:pl-5">
              <div className="sticky left-0 w-max px-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                Свои колонки <span className="font-normal normal-case tracking-normal">· по вашим условиям</span>
              </div>
              <div className="flex min-h-0 flex-1 items-stretch gap-3">
                {mine.map(renderSec)}
                {custom && <AddColumnTile disabled={mine.length >= MAX_CUSTOM_COLUMNS} onClick={custom.onAdd} />}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
