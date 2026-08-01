'use client';
// Панель вкладок отчётов (фича Серёги 01.08, «как в браузере»). UI-слой:
// список вкладок + «+»; клик — переключение, крестик — закрытие, dblclick —
// переименование. Drag-перестановка НЕ реализована (осознанный пропуск —
// дорого относительно ценности, отмечено в отчёте задачи). Мобильная вёрстка:
// горизонтальный скролл (overflow-x-auto, вкладки не переносятся).
import { useState, useRef, useEffect } from 'react';
import { Plus, X } from 'lucide-react';
import type { ReportTab } from '@/features/reports/lib/reportTabs';

interface Props {
  tabs: ReportTab[];
  activeId: string | null;
  onSelect: (tab: ReportTab) => void;
  onClose: (tab: ReportTab) => void;
  onAdd: () => void;
  onRename: (tab: ReportTab, name: string) => void;
}

export function ReportTabsBar({ tabs, activeId, onSelect, onClose, onAdd, onRename }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingId) inputRef.current?.select();
  }, [renamingId]);

  function commitRename(tab: ReportTab) {
    setRenamingId(null);
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== tab.name) onRename(tab, trimmed);
  }

  if (tabs.length === 0) return null;

  return (
    <div className="flex items-end gap-1 px-3 pt-1.5 bg-[var(--color-bg)] border-b border-[var(--color-border)] overflow-x-auto overflow-y-hidden flex-shrink-0 scrollbar-thin">
      {tabs.map(tab => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            onClick={() => { if (!active) onSelect(tab); }}
            onDoubleClick={() => { setRenamingId(tab.id); setNameValue(tab.name); }}
            title={tab.name}
            className={[
              'group flex items-center gap-1.5 max-w-[220px] min-w-[90px] flex-shrink-0 pl-3 pr-1.5 h-8 rounded-t-[8px] border border-b-0 cursor-pointer select-none transition-colors',
              active
                ? 'bg-[var(--color-bg-surface)] border-[var(--color-border)] text-[var(--color-text)] font-medium relative -mb-px'
                : 'bg-transparent border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-bg-surface)]/60 hover:border-[var(--color-border)]',
            ].join(' ')}
          >
            {renamingId === tab.id ? (
              <input
                ref={inputRef}
                autoFocus
                value={nameValue}
                onChange={e => setNameValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename(tab);
                  if (e.key === 'Escape') setRenamingId(null);
                }}
                onBlur={() => commitRename(tab)}
                onClick={e => e.stopPropagation()}
                className="text-[12.5px] bg-[var(--color-bg)] border border-[var(--color-accent)] rounded px-1 py-0 outline-none w-full min-w-0"
              />
            ) : (
              <span className="text-[12.5px] truncate">{tab.name}</span>
            )}
            <button
              onClick={e => { e.stopPropagation(); onClose(tab); }}
              className="w-5 h-5 flex-shrink-0 flex items-center justify-center rounded hover:bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-negative)] opacity-0 group-hover:opacity-100 transition-opacity"
              title="Закрыть вкладку"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <button
        onClick={onAdd}
        className="w-7 h-7 mb-0.5 flex-shrink-0 flex items-center justify-center rounded-[7px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-accent)] transition-colors"
        title="Новая вкладка (копия текущего отчёта)"
      >
        <Plus size={15} />
      </button>
    </div>
  );
}
