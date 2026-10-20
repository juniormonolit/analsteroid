'use client';
import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import { Popover } from '@/components/ui/Popover';

/**
 * Выбор из длинного списка С ПОИСКОМ (правка владельца 20.10: «уебищный режим выбора по
 * умолчанию без поиска»). Нативный <select> на 270 менеджеров — это пролистывание
 * простыни; здесь — поле поиска сверху (фокус сразу), фильтр по подстроке в названии
 * и подсказке (отдел), стрелки ↑/↓ + Enter, Esc закрывает. Панель — Radix Popover:
 * сам прижимается к краям экрана, на телефоне не уезжает.
 *
 * Правило проекта (CLAUDE.md, адаптивность п.14): список людей/отделов/проектов и любой
 * динамический список длиннее ~10 пунктов — только этот компонент, не голый <select>.
 */
export interface SearchSelectOption {
  value: string;
  label: string;
  /** Вторая строка мелко (отдел, роль) — по ней тоже ищется. */
  hint?: string | null;
}

export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = 'Выберите…',
  allLabel,
  searchPlaceholder = 'Поиск…',
  className,
  panelClassName,
  ariaLabel,
  disabled,
}: {
  options: SearchSelectOption[];
  value: string;
  onChange: (value: string) => void;
  /** Текст кнопки, когда ничего не выбрано и allLabel не задан. */
  placeholder?: string;
  /** Пункт «все» с пустым значением (''). Не задан — пустого пункта нет. */
  allLabel?: string;
  searchPlaceholder?: string;
  /** Классы кнопки-триггера (ширина и т.п.). */
  className?: string;
  panelClassName?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = allLabel !== undefined ? [{ value: '', label: allLabel }, ...options] : options;
    if (!needle) return base;
    return base.filter(o => o.value === '' ? false : `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(needle));
  }, [options, q, allLabel]);

  const selected = options.find(o => o.value === value);
  const buttonText = selected ? selected.label : value === '' && allLabel !== undefined ? allLabel : placeholder;

  const choose = (v: string) => { onChange(v); setOpen(false); setQ(''); };
  const setOpenState = (o: boolean) => {
    setOpen(o);
    if (o) { setQ(''); setActive(Math.max(0, items.findIndex(i => i.value === value))); }
  };
  const move = (d: number) => {
    setActive(a => {
      const n = Math.min(Math.max(a + d, 0), items.length - 1);
      listRef.current?.querySelector<HTMLElement>(`[data-idx="${n}"]`)?.scrollIntoView({ block: 'nearest' });
      return n;
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpenState}
      className={twMerge('w-[320px] max-w-[calc(100vw-16px)] p-0', panelClassName)}
      trigger={
        <button type="button" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
          className={twMerge('flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-left text-base text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50 sm:text-sm', className)}>
          <span className="min-w-0 flex-1 truncate">{buttonText}</span>
          <ChevronDown size={14} className="shrink-0 text-[var(--color-text-muted)]" />
        </button>
      }
    >
      <div className="flex flex-col">
        <label className="flex items-center gap-2 border-b border-[var(--color-border)] px-3">
          <Search size={14} className="shrink-0 text-[var(--color-text-muted)]" />
          <input
            value={q}
            onChange={e => { setQ(e.target.value); setActive(0); }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
              else if (e.key === 'Enter') { e.preventDefault(); const it = items[active]; if (it) choose(it.value); }
            }}
            placeholder={searchPlaceholder}
            autoFocus
            className="min-h-11 min-w-0 flex-1 bg-transparent text-[16px] text-[var(--color-text)] outline-none sm:text-sm"
          />
          {q && (
            <button type="button" onClick={() => setQ('')} aria-label="Очистить поиск" className="tap-target text-[var(--color-text-muted)]">
              <X size={14} />
            </button>
          )}
        </label>
        <div ref={listRef} role="listbox" className="max-h-[min(60vh,420px)] overflow-y-auto p-1">
          {items.map((o, i) => {
            const isSel = o.value === value;
            return (
              <button key={o.value || '__all'} type="button" role="option" aria-selected={isSel} data-idx={i}
                onClick={() => choose(o.value)} onMouseEnter={() => setActive(i)}
                className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${i === active ? 'bg-[var(--color-bg-hover)]' : ''} ${isSel ? 'font-medium text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {'hint' in o && o.hint && <span className="block truncate text-[11px] text-[var(--color-text-muted)]">{o.hint}</span>}
                </span>
                {isSel && <Check size={14} className="shrink-0" />}
              </button>
            );
          })}
          {items.length === 0 && <div className="px-2 py-3 text-center text-xs text-[var(--color-text-muted)]">Ничего не нашлось</div>}
        </div>
      </div>
    </Popover>
  );
}
