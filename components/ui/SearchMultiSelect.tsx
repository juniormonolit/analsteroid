'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import { Popover } from '@/components/ui/Popover';
import type { SearchSelectOption } from '@/components/ui/SearchSelect';

/**
 * Мультивыбор с поиском (владелец 20.10: «менеджеры должны выбираться галочками, чтобы
 * смотреть сразу несколько, но не весь отдел»). Тот же вид, что у SearchSelect: поиск
 * сверху, строки 44px, Radix Popover. Пустой выбор = «все» (allLabel). Применяется
 * сразу по клику — без «Применить», как и одиночный выбор.
 */
export function SearchMultiSelect({
  options, value, onChange, allLabel = 'Все', unitLabel = 'выбрано', searchPlaceholder = 'Поиск…',
  className, panelClassName, ariaLabel,
}: {
  options: SearchSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  /** Текст кнопки при пустом выборе. */
  allLabel?: string;
  /** «3 менеджера» — подпись при выборе нескольких (число подставляется спереди). */
  unitLabel?: string;
  searchPlaceholder?: string;
  className?: string;
  panelClassName?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  // Свой текущий набор: родитель обычно хранит выбор в адресной строке, и её обновление
  // асинхронно — два быстрых клика считали бы от старого value и затирали друг друга
  // (поймано 20.10: отметил двоих — осталась одна). Синхронизируемся с value извне.
  const [sel, setSel] = useState<string[]>(value);
  const selRef = useRef(sel);
  const valueKey = value.join(',');
  // Сверяемся по содержимому, не по ссылке: массив из адресной строки — новый на каждый рендер.
  useEffect(() => { setSel(value); selRef.current = value; }, [valueKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = useMemo(() => new Set(sel), [sel]);
  const commit = (next: string[]) => { selRef.current = next; setSel(next); onChange(next); };
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? options.filter(o => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(needle)) : options;
  }, [options, q]);

  const toggle = (v: string) => {
    const next = new Set(selRef.current);
    if (next.has(v)) next.delete(v); else next.add(v);
    commit(options.map(o => o.value).filter(x => next.has(x)));
  };
  const one = sel.length === 1 ? options.find(o => o.value === sel[0]) : null;
  const buttonText = sel.length === 0 ? allLabel : one ? one.label : `${sel.length} ${unitLabel}`;

  return (
    <Popover
      open={open}
      onOpenChange={o => { setOpen(o); if (o) setQ(''); }}
      className={twMerge('w-[320px] max-w-[calc(100vw-16px)] p-0', panelClassName)}
      trigger={
        <button type="button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
          className={twMerge('flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-left text-base text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] sm:text-sm', className)}>
          <span className="min-w-0 flex-1 truncate">{buttonText}</span>
          <ChevronDown size={14} className="shrink-0 opacity-70" />
        </button>
      }
    >
      <div className="flex flex-col">
        <label className="flex items-center gap-2 border-b border-[var(--color-border)] px-3">
          <Search size={14} className="shrink-0 text-[var(--color-text-muted)]" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={searchPlaceholder} autoFocus
            className="min-h-11 min-w-0 flex-1 bg-transparent text-[16px] text-[var(--color-text)] outline-none sm:text-sm" />
          {q && (
            <button type="button" onClick={() => setQ('')} aria-label="Очистить поиск" className="tap-target text-[var(--color-text-muted)]">
              <X size={14} />
            </button>
          )}
        </label>
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-1 text-xs">
          <button type="button" className="min-h-9 text-[var(--color-accent)] hover:underline disabled:opacity-40" disabled={!items.length}
            onClick={() => commit(options.map(o => o.value).filter(v => selected.has(v) || items.some(i => i.value === v)))}>
            {q ? 'Отметить найденных' : 'Отметить всех'}
          </button>
          <button type="button" className="min-h-9 text-[var(--color-text-muted)] hover:underline disabled:opacity-40" disabled={!sel.length}
            onClick={() => commit([])}>
            Сбросить · {allLabel.toLowerCase()}
          </button>
        </div>
        <div role="listbox" aria-multiselectable className="max-h-[min(60vh,420px)] overflow-y-auto p-1">
          {items.map(o => {
            const on = selected.has(o.value);
            return (
              <button key={o.value} type="button" role="option" aria-selected={on} onClick={() => toggle(o.value)}
                className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border-strong)]'}`}>
                  {on && <Check size={12} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {o.hint && <span className="block truncate text-[11px] text-[var(--color-text-muted)]">{o.hint}</span>}
                </span>
              </button>
            );
          })}
          {items.length === 0 && <div className="px-2 py-3 text-center text-xs text-[var(--color-text-muted)]">Ничего не нашлось</div>}
        </div>
      </div>
    </Popover>
  );
}
