'use client';

import { RotateCcw, X } from 'lucide-react';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/SearchSelect';
import { btnSecondary } from './shared';

// Панель массовых действий (спека §8): при выделении заменяет нижнюю панель шага.

export function BulkBar({ count, extra, recipients, onTransfer, onBrak, brakLabel = 'В брак', onReset, onClear, children }: {
  count: number;
  /** «LTV 3,2 млн» и т.п. */
  extra?: string;
  recipients?: SearchSelectOption[];
  onTransfer?: (id: number) => void;
  onBrak?: () => void;
  brakLabel?: string;
  onReset?: () => void;
  onClear: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center">
      <div className="flex min-w-0 items-center gap-2 md:flex-1">
        <span className="text-sm font-medium text-[var(--color-text)]">Выбрано {count.toLocaleString('ru-RU')}</span>
        {extra && <span className="truncate text-sm tabular-nums text-[var(--color-text-muted)]">· {extra}</span>}
        <button type="button" onClick={onClear} aria-label="Снять выделение" className="tap-target ml-auto rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] md:ml-1"><X size={16} /></button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onTransfer && recipients && (
          <SearchSelect options={recipients} value="" onChange={v => v && onTransfer(Number(v))} searchable placeholder="Передать…"
            searchPlaceholder="Имя, должность, отдел…" ariaLabel="Передать выбранные" className="min-w-0 flex-1 md:w-[220px] md:flex-none"
            panelClassName="w-[400px] max-w-[calc(100vw-16px)]" />
        )}
        {children}
        {onBrak && <button type="button" onClick={onBrak} className={`${btnSecondary} text-[var(--color-warning)]`}>{brakLabel}</button>}
        {onReset && <button type="button" onClick={onReset} className={btnSecondary}><RotateCcw size={14} /> К правилу</button>}
      </div>
    </div>
  );
}
