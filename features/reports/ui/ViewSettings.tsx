'use client';
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Type } from 'lucide-react';
import type { ComparisonDisplay, AccountType } from '@/lib/metrics/types';

export type Density = 'compact' | 'normal' | 'relaxed';
export interface ViewPrefs { density: Density; fontScale: number }

export const DEFAULT_VIEW_PREFS: ViewPrefs = { density: 'normal', fontScale: 1 };
const LS_KEY = 'report-view-prefs';

export function loadViewPrefs(): ViewPrefs {
  if (typeof window === 'undefined') return DEFAULT_VIEW_PREFS;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_VIEW_PREFS;
    return { ...DEFAULT_VIEW_PREFS, ...JSON.parse(raw) };
  } catch { return DEFAULT_VIEW_PREFS; }
}
export function saveViewPrefs(p: ViewPrefs) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

const DENSITY_LABELS: Record<Density, string> = {
  compact: 'Компактно',
  normal: 'Обычно',
  relaxed: 'Просторно',
};

export type NumberAlign = 'left' | 'center' | 'right';
const ALIGN_LABELS: Record<NumberAlign, string> = { left: 'Лево', center: 'Центр', right: 'Право' };

function Seg<T extends string>({ options, value, onChange, labels }: {
  options: T[]; value: T | undefined; onChange: (v: T) => void; labels: Record<T, string>;
}) {
  return (
    <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-[11px]">
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">{children}</div>;
}

interface ViewSettingsProps {
  prefs: ViewPrefs;
  onChange: (p: ViewPrefs) => void;
  numberAlign?: NumberAlign;
  onNumberAlignChange?: (a: NumberAlign) => void;
  comparisonDisplay?: ComparisonDisplay;
  hasMixedDisplay?: boolean;
  onComparisonDisplayChange?: (v: ComparisonDisplay) => void;
  accountType?: AccountType;
  onAccountTypeChange?: (a: AccountType) => void;
  drilldownGrouped?: boolean;
  onDrilldownGroupedChange?: (v: boolean) => void;
  colorizeMetrics?: boolean;
  onColorizeMetricsChange?: (v: boolean) => void;
}

export function ViewSettings({
  prefs, onChange, numberAlign, onNumberAlignChange,
  comparisonDisplay, hasMixedDisplay, onComparisonDisplayChange,
  accountType, onAccountTypeChange,
  drilldownGrouped, onDrilldownGroupedChange,
  colorizeMetrics, onColorizeMetricsChange,
}: ViewSettingsProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

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
      setPos({ top: r.bottom + 4, left: Math.max(8, r.right - 260) });
    }
    setOpen(v => !v);
  }

  const fontPct = Math.round(prefs.fontScale * 100);

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <Type size={12} />
        Вид
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 260, maxHeight: 'calc(100vh - 80px)', overflowY: 'auto' }}
          className="z-[1000] bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-lg p-3 flex flex-col gap-3"
        >
          {onAccountTypeChange && (
            <div>
              <SectionLabel>Тип аккаунтов</SectionLabel>
              <Seg
                options={['managers', 'logists', 'all'] as AccountType[]}
                value={accountType ?? 'managers'}
                onChange={onAccountTypeChange}
                labels={{ managers: 'Менеджеры', logists: 'Логисты', all: 'Все' }}
              />
            </div>
          )}

          {onComparisonDisplayChange && (
            <div>
              <SectionLabel>
                Режим колонок{hasMixedDisplay && <span className="ml-1 normal-case font-normal text-[10px] tracking-normal">· смешанный</span>}
              </SectionLabel>
              <Seg
                options={['full', 'current', 'compact'] as ComparisonDisplay[]}
                value={hasMixedDisplay ? undefined : comparisonDisplay}
                onChange={onComparisonDisplayChange}
                labels={{ full: 'Сравнение', current: 'Текущий', compact: 'Компактн.' }}
              />
            </div>
          )}

          <div>
            <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">Плотность строк</div>
            <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
              {(['compact', 'normal', 'relaxed'] as Density[]).map(d => (
                <button
                  key={d}
                  onClick={() => onChange({ ...prefs, density: d })}
                  className={`flex-1 px-2 py-1.5 transition-colors ${prefs.density === d ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
                >
                  {DENSITY_LABELS[d]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">Размер шрифта</span>
              <span className="text-xs text-[var(--color-text-muted)]">{fontPct}%</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onChange({ ...prefs, fontScale: Math.max(0.8, +(prefs.fontScale - 0.1).toFixed(2)) })}
                className="w-7 h-7 flex items-center justify-center border border-[var(--color-border)] rounded hover:bg-[var(--color-bg-hover)] text-sm"
              >A−</button>
              <input
                type="range" min={0.8} max={1.5} step={0.05}
                value={prefs.fontScale}
                onChange={e => onChange({ ...prefs, fontScale: +e.target.value })}
                className="flex-1 accent-[var(--color-accent)]"
              />
              <button
                onClick={() => onChange({ ...prefs, fontScale: Math.min(1.5, +(prefs.fontScale + 0.1).toFixed(2)) })}
                className="w-7 h-7 flex items-center justify-center border border-[var(--color-border)] rounded hover:bg-[var(--color-bg-hover)] text-base"
              >A+</button>
            </div>
          </div>

          {onNumberAlignChange && (
            <div>
              <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">Выравнивание чисел</div>
              <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
                {(['left', 'center', 'right'] as NumberAlign[]).map(a => (
                  <button
                    key={a}
                    onClick={() => onNumberAlignChange(a)}
                    className={`flex-1 px-2 py-1.5 transition-colors ${(numberAlign ?? 'center') === a ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
                  >
                    {ALIGN_LABELS[a]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {onDrilldownGroupedChange && (
            <div>
              <SectionLabel>Группировка в drilldown</SectionLabel>
              <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
                {([true, false] as const).map(v => (
                  <button
                    key={String(v)}
                    onClick={() => onDrilldownGroupedChange(v)}
                    className={`flex-1 px-2 py-1.5 transition-colors ${(drilldownGrouped ?? true) === v ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
                  >
                    {v ? 'Да' : 'Нет'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {onColorizeMetricsChange && (
            <div>
              <SectionLabel>Выделять показатели цветом</SectionLabel>
              <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
                {([true, false] as const).map(v => (
                  <button
                    key={String(v)}
                    onClick={() => onColorizeMetricsChange(v)}
                    className={`flex-1 px-2 py-1.5 transition-colors ${(colorizeMetrics ?? false) === v ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
                  >
                    {v ? 'Да' : 'Нет'}
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={() => onChange(DEFAULT_VIEW_PREFS)}
            className="text-xs text-[var(--color-accent)] hover:underline self-start"
          >
            Сбросить
          </button>
        </div>,
        document.body
      )}
    </>
  );
}
