'use client';
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Type } from 'lucide-react';

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

export function ViewSettings({ prefs, onChange }: { prefs: ViewPrefs; onChange: (p: ViewPrefs) => void }) {
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
      setPos({ top: r.bottom + 4, left: Math.max(8, r.right - 240) });
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
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 240 }}
          className="z-[1000] bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-lg p-3 flex flex-col gap-3"
        >
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
