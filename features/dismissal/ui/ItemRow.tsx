'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, Search, X } from 'lucide-react';
import type { DismissalItem } from '../types';
import { cleanTitle } from './cleanTitle';

// Строки списков мастера (спека §8): выделение (клик по чекбоксу, Shift — диапазон), фокус,
// клавиатура: ↑/↓ (j/k), Space — выделить, 1–9 — назначить N-му из панели, B — брак/закрыть,
// Backspace — к правилу, Ctrl/Cmd+A — всё отфильтрованное, Esc — снять, Enter — выбор получателя.

export interface RowSelection {
  selected: Set<string>;
  focus: string | null;
  setFocus: (k: string | null) => void;
  toggle: (k: string, shift?: boolean) => void;
  clear: () => void;
  selectMany: (keys: string[]) => void;
  /** Строки для действия: выделенные, иначе строка в фокусе */
  targets: () => string[];
}

export function useRowSelection(keys: string[]): RowSelection {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  // строки, ушедшие из списка (фильтр, смена топа), из выделения убираем
  const keySig = keys.join('|');
  useEffect(() => {
    const set = new Set(keysRef.current);
    setSelected(prev => {
      const next = new Set([...prev].filter(k => set.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [keySig]);
  const toggle = useCallback((k: string, shift?: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      const ks = keysRef.current;
      if (shift && anchor.current && ks.includes(anchor.current)) {
        const [a, b] = [ks.indexOf(anchor.current), ks.indexOf(k)].sort((x, y) => x - y);
        for (let i = a; i <= b; i++) next.add(ks[i]);
      } else if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
    anchor.current = k;
    setFocus(k);
  }, []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const selectMany = useCallback((ks: string[]) => setSelected(new Set(ks)), []);
  const targets = () => (selected.size ? [...selected] : focus ? [focus] : []);
  return { selected, focus, setFocus, toggle, clear, selectMany, targets };
}

/** Обработчик клавиш списка. Не мешает вводу в полях. */
export function useListKeys(keys: string[], sel: RowSelection, h: {
  onAssign?: (n: number, targets: string[]) => void;
  onBrak?: (targets: string[]) => void;
  onReset?: (targets: string[]) => void;
}) {
  return (e: React.KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, [role="listbox"], [role="dialog"]')) return;
    const idx = sel.focus ? keys.indexOf(sel.focus) : -1;
    const move = (d: number) => {
      e.preventDefault();
      const n = Math.min(Math.max(idx + d, 0), keys.length - 1);
      const k = keys[n];
      if (!k) return;
      sel.setFocus(k);
      e.currentTarget.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown' || e.key === 'j') move(1);
    else if (e.key === 'ArrowUp' || e.key === 'k') move(-1);
    else if (e.key === ' ' && sel.focus) { e.preventDefault(); sel.toggle(sel.focus, e.shiftKey); }
    else if (e.key === 'Escape') sel.clear();
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); sel.selectMany(keys); }
    else if (/^[1-9]$/.test(e.key) && h.onAssign && !e.metaKey && !e.ctrlKey) { e.preventDefault(); h.onAssign(Number(e.key) - 1, sel.targets()); }
    else if ((e.key === 'b' || e.key === 'и') && h.onBrak) { e.preventDefault(); h.onBrak(sel.targets()); }
    else if (e.key === 'Backspace' && h.onReset) { e.preventDefault(); h.onReset(sel.targets()); }
    else if (e.key === 'Enter' && sel.focus) {
      // открыть выбор получателя в строке
      const row = e.currentTarget.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(sel.focus)}"]`);
      const btn = row?.querySelector<HTMLButtonElement>('[data-recipient] button');
      if (btn) { e.preventDefault(); btn.click(); }
    }
  };
}

/** Классы строки по фокусу/выделению. */
export function rowCls(focused: boolean, selected: boolean): string {
  return `${selected ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-table-row-hover)]'} ${focused ? 'ring-2 ring-inset ring-[var(--color-border-focus)]' : ''}`;
}

export function RowCheck({ checked, onToggle, label }: { checked: boolean; onToggle: (shift: boolean) => void; label: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label}
      onClick={e => { e.stopPropagation(); onToggle(e.shiftKey); }}
      className={`tap-target flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border ${checked ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border-strong)] bg-[var(--color-bg-surface)]'}`}>
      {checked && <Check size={12} />}
    </button>
  );
}

/** Название без шума: капс-префикс бейджем, заглушка «Без названия · #id» серым. */
export function TitleText({ item, link = true, className = '' }: { item: DismissalItem; link?: boolean; className?: string }) {
  const t = cleanTitle(item.title, item.entityId);
  const text = <span className={`min-w-0 truncate ${t.placeholder ? 'text-[var(--color-text-muted)]' : ''}`}>{t.text}</span>;
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center gap-1.5 ${className}`}>
      {link && item.url ? (
        <a href={item.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
          className={`inline-flex min-w-0 items-center gap-1 hover:underline ${t.placeholder ? '' : 'text-[var(--color-accent)]'}`}>
          {text}<ExternalLink size={11} className="shrink-0 opacity-60" />
        </a>
      ) : text}
      {t.badge && <span className="shrink-0 rounded bg-[var(--color-bg-hover)] px-1.5 py-px text-[10px] uppercase text-[var(--color-text-muted)]">{t.badge}</span>}
    </span>
  );
}

export function SearchBox({ value, onChange, placeholder = 'Поиск' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 sm:max-w-[320px]">
      <Search size={14} className="shrink-0 text-[var(--color-text-muted)]" />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-base text-[var(--color-text)] outline-none sm:text-sm" />
      {value && <button type="button" onClick={() => onChange('')} aria-label="Очистить поиск" className="tap-target text-[var(--color-text-muted)]"><X size={14} /></button>}
    </label>
  );
}

/** Фильтр-чипы (переносятся, без горизонтальной ленты). */
export function Chips<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(o => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}
          className={`min-h-11 rounded-full border px-3 text-sm ${o.value === value ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptySearch({ onReset }: { onReset: () => void }) {
  return (
    <div className="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
      Ничего не нашлось · <button type="button" onClick={onReset} className="min-h-11 font-medium text-[var(--color-accent)] hover:underline">Сбросить</button>
    </div>
  );
}

export function MoreButton({ left, onClick }: { left: number; onClick: () => void }) {
  if (left <= 0) return null;
  return (
    <button type="button" onClick={onClick}
      className="flex min-h-11 w-full items-center justify-center border-t border-[var(--color-border)] text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
      Показать ещё (осталось {left.toLocaleString('ru-RU')})
    </button>
  );
}

export function KeyHint({ brak = 'брак' }: { brak?: string }) {
  const k = (s: string) => <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-bg-hover)] px-1 text-[10px]">{s}</kbd>;
  return (
    <p className="hidden px-4 py-2 text-[11px] text-[var(--color-text-muted)] lg:block">
      {k('↑')}{k('↓')} строки · {k('Space')} выделить · {k('Shift')}+клик диапазон · {k('1')}–{k('9')} отдать получателю из панели · {k('Enter')} выбрать получателя · {k('B')} {brak} · {k('⌫')} к правилу · {k('Ctrl')}+{k('A')} всё · {k('Esc')} снять
    </p>
  );
}
