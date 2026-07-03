'use client';
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Filter } from 'lucide-react';
import type { DealScope, ClientType, ProductGroupMode } from '@/lib/metrics/types';

function Seg<T extends string>({ options, value, onChange, labels }: {
  options: T[]; value: T; onChange: (v: T) => void; labels: Record<T, string>;
}) {
  return (
    <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
      {options.map(o => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`flex-1 px-2 py-1.5 transition-colors whitespace-nowrap ${value === o ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
        >
          {labels[o]}
        </button>
      ))}
    </div>
  );
}

interface Props {
  dealScope: DealScope;
  onDealScopeChange: (v: DealScope) => void;
  clientType: ClientType;
  onClientTypeChange: (v: ClientType) => void;
  productGroupMode?: ProductGroupMode;
  onProductGroupModeChange?: (v: ProductGroupMode) => void;
  showProductGroupPicker?: boolean;
}

export function FiltersMenu({ dealScope, onDealScopeChange, clientType, onClientTypeChange, productGroupMode, onProductGroupModeChange, showProductGroupPicker }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Count of non-default filters → badge so the active state is visible without opening.
  // Defaults: all deals, all clients, «По наибольшему» (by_max).
  const activeCount = (dealScope !== 'all' ? 1 : 0) + (clientType !== 'all' ? 1 : 0)
    + (showProductGroupPicker && productGroupMode && productGroupMode !== 'by_max' ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: Math.max(8, r.left) });
    }
    setOpen(v => !v);
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <Filter size={12} />
        Фильтры
        {activeCount > 0 && (
          <span className="ml-1 px-1.5 py-0.5 bg-[var(--color-accent)] text-white rounded-full text-[10px]">{activeCount}</span>
        )}
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 240 }}
          className="z-[1000] bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-lg p-3 flex flex-col gap-3"
        >
          <div>
            <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">Тип сделок</div>
            <Seg
              options={['primary', 'repeat', 'all'] as DealScope[]}
              value={dealScope}
              onChange={onDealScopeChange}
              labels={{ primary: 'Первичные', repeat: 'Повторные', all: 'Все' }}
            />
          </div>
          <div>
            <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">Тип клиента</div>
            <Seg
              options={['b2c', 'b2b', 'all'] as ClientType[]}
              value={clientType}
              onChange={onClientTypeChange}
              labels={{ b2c: 'Физлица', b2b: 'Юрлица', all: 'Все' }}
            />
          </div>
          {showProductGroupPicker && onProductGroupModeChange && productGroupMode !== undefined && (
            <div>
              <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">Товарные группы</div>
              <Seg
                options={['kc', 'by_max'] as ProductGroupMode[]}
                value={productGroupMode}
                onChange={onProductGroupModeChange}
                labels={{ kc: 'Категория КЦ', by_max: 'По наибольшему' }}
              />
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
