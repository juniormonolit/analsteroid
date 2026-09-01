'use client';
// Панель вкладок отчётов (фича Серёги 01.08, «как в браузере»). UI-слой:
// список вкладок + «+»; клик — переключение, крестик — закрытие, dblclick —
// переименование. Drag-перестановка НЕ реализована (осознанный пропуск —
// дорого относительно ценности, отмечено в отчёте задачи). Мобильная вёрстка:
// горизонтальный скролл (scroll-x, вкладки не переносятся) + градиент-затухание
// у края + автоскролл активной вкладки в видимую область — тот же приём, что
// ManagerTabBar (features/manager-card/ui/ManagerTabs.tsx, задача 2779).
import { useState, useRef, useEffect, useCallback } from 'react';
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const firstRun = useRef(true);

  useEffect(() => {
    if (renamingId) inputRef.current?.select();
  }, [renamingId]);

  const updateFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setFade({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  }, []);

  useEffect(() => {
    updateFade();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateFade, { passive: true });
    const ro = new ResizeObserver(updateFade);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', updateFade); ro.disconnect(); };
  }, [updateFade, tabs.length]);

  useEffect(() => {
    // Автоскролл активной вкладки в видимую область (та же обязаловка, что у
    // ManagerTabBar, задача 2779) — открыли новый отчёт/переключились издалека —
    // вкладка не должна оставаться за краем невидимой.
    const el = scrollRef.current;
    if (!el || !activeId) return;
    const activeEl = el.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`);
    activeEl?.scrollIntoView({ behavior: firstRun.current ? 'auto' : 'smooth', inline: 'nearest', block: 'nearest' });
    firstRun.current = false;
  }, [activeId]);

  function commitRename(tab: ReportTab) {
    setRenamingId(null);
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== tab.name) onRename(tab, trimmed);
  }

  if (tabs.length === 0) return null;

  return (
    <div className="relative min-w-0 flex-shrink-0">
      <div
        ref={scrollRef}
        className="scroll-x scrollbar-none flex min-w-0 items-end gap-1 snap-x snap-proximity overflow-y-hidden border-b border-[var(--color-border)] bg-[var(--color-bg)] px-3 pt-1.5"
      >
      {tabs.map(tab => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            onClick={() => { if (!active) onSelect(tab); }}
            onDoubleClick={() => { setRenamingId(tab.id); setNameValue(tab.name); }}
            title={tab.name}
            className={[
              'group flex snap-start items-center gap-1.5 max-w-[220px] min-w-[90px] flex-shrink-0 pl-3 pr-1.5 h-11 sm:h-8 rounded-t-[8px] border border-b-0 cursor-pointer select-none transition-colors',
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
                  if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
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
              className="tap-target hover-reveal w-5 h-5 flex-shrink-0 flex items-center justify-center rounded hover:bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-negative)] transition-opacity"
              title="Закрыть вкладку"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <button
        onClick={onAdd}
        className="tap-target w-7 h-7 mb-0.5 flex-shrink-0 flex items-center justify-center rounded-[7px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-accent)] transition-colors"
        title="Новая вкладка (копия текущего отчёта)"
      >
        <Plus size={15} />
      </button>
      </div>
      {/* Градиент-затухание у края — тот же приём и та же логика честности
          (только по факту scrollLeft), что ManagerTabBar. Цвет — --color-bg,
          фон именно этой полосы (не --color-bg-surface, как у активной вкладки). */}
      {fade.left && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 top-1.5 w-6"
          style={{ background: 'linear-gradient(to right, var(--color-bg), transparent)' }}
        />
      )}
      {fade.right && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 top-1.5 w-6"
          style={{ background: 'linear-gradient(to left, var(--color-bg), transparent)' }}
        />
      )}
    </div>
  );
}
