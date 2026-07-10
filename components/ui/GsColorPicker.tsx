'use client';
import { useState, useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import { GOOGLE_SHEETS_PALETTE_GRID } from '@/lib/colors/google-sheets-palette';

// Единый пикер цвета — палитра Google Sheets (~80 свотчей: градации серого +
// 10 базовых цветов + ступени тонов), п.10 спеки owners-inbox/analsteroid-edits-spec-agreed-20260708.md
// («цвета как в гугл-шитс»). Изначально жил только в /settings/metric-colors —
// вынесен сюда, чтобы переиспользовать в подсветке значений (п.9 спеки), не дублируя код.

/** Один свотч палитры: бордер + inset-подсветка (чтобы светлые тона не терялись
 * на белом фоне), выбранный — жирная рамка + галочка. */
export function GsSwatch({ color, selected, onClick }: { color: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={color}
      className="relative w-[22px] h-[22px] rounded-md shrink-0 transition-transform hover:scale-110"
      style={{
        backgroundColor: color,
        border: selected ? '2px solid var(--color-text)' : '1px solid var(--color-swatch-border)',
        boxShadow: selected
          ? '0 0 0 2px rgba(91,141,239,.28), 0 1px 3px rgba(0,0,0,.15)'
          : 'inset 0 0 0 1px rgba(255,255,255,.4)',
      }}
    >
      {selected && (
        <Check
          size={12}
          strokeWidth={3}
          className="absolute inset-0 m-auto text-white"
          style={{ filter: 'drop-shadow(0 0 1px rgba(0,0,0,.6))' }}
        />
      )}
    </button>
  );
}

/** Попап с сеткой стандартной палитры Google Sheets. Закрывается кликом вне себя
 * или по выбору цвета. */
export function GsPalettePopover({ value, onChange, onClose }: { value: string; onChange: (c: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const lower = value.toLowerCase();
  return (
    <div
      ref={ref}
      className="absolute z-50 top-full left-0 mt-1.5 p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-lg"
    >
      <div className="flex flex-col gap-1.5">
        {GOOGLE_SHEETS_PALETTE_GRID.map((row, i) => (
          <div key={i} className="flex gap-1.5">
            {row.map((c, j) => (
              <GsSwatch key={`${i}-${j}-${c}`} color={c} selected={lower === c} onClick={() => { onChange(c); onClose(); }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Кнопка текущего цвета, открывающая GsPalettePopover. Единственный способ выбора
 * цвета в проекте — только из стандартной палитры Google Sheets. */
export function GsColorPickerButton({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title={value}
        className="w-7 h-7 rounded-lg border border-[var(--color-border)] cursor-pointer transition-transform hover:scale-105"
        style={{ backgroundColor: value, boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.4)' }}
      />
      {open && <GsPalettePopover value={value} onChange={onChange} onClose={() => setOpen(false)} />}
    </span>
  );
}
