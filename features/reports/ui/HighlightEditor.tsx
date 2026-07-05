'use client';
import { useState, useEffect } from 'react';
import type { MetricHighlightConfig, HighlightThreshold } from '@/lib/saved-reports/types';
import type { ComparisonDisplay } from '@/lib/metrics/types';

const DISPLAY_OPTIONS: { value: ComparisonDisplay; label: string }[] = [
  { value: 'full',    label: 'Полное сравнение' },
  { value: 'current', label: 'Только текущий' },
  { value: 'compact', label: 'Компактное' },
];

const COLORS = [
  { label: 'Зелёный',   value: '#bbf7d0' },
  { label: 'Жёлтый',   value: '#fef9c3' },
  { label: 'Оранжевый', value: '#fed7aa' },
  { label: 'Красный',   value: '#fecaca' },
  { label: 'Синий',     value: '#bfdbfe' },
  { label: 'Серый',     value: '#e5e7eb' },
];

const DEFAULT_COLOR = COLORS[5].value;

function defaultConfig(thresholdCount: number): MetricHighlightConfig {
  const thresholds: HighlightThreshold[] = Array.from({ length: thresholdCount - 1 }, (_, i) => ({
    value: (i + 1) * 10,
    color: COLORS[i % COLORS.length].value,
  }));
  return { enabled: true, thresholds, aboveColor: COLORS[thresholdCount - 1 < COLORS.length ? thresholdCount - 1 : 0].value };
}

interface Props {
  metricName: string;
  dataType?: string;
  initial: MetricHighlightConfig | null;
  onSave: (config: MetricHighlightConfig | null, scope: 'report' | 'global') => void;
  onClose: () => void;
  displayMode?: ComparisonDisplay;
  onDisplayModeChange?: (mode: ComparisonDisplay) => void;
  isPinned?: boolean;
  onPinToggle?: () => void;
  isAccented?: boolean;
  onAccentToggle?: () => void;
  isBar?: boolean;
  onBarToggle?: () => void;
  isHeatmap?: boolean;
  onHeatmapToggle?: () => void;
  isHeatmapInverted?: boolean;
  onHeatmapInvertToggle?: () => void;
  decimalPlaces?: number;
  onDecimalPlacesChange?: (v: number) => void;
  comparisonThreshold?: number;
  onComparisonThresholdChange?: (v: number) => void;
  // Док-режим: редактор прижимается к left=anchorLeft (справа от панели метрик),
  // без бэкдропа — панель остаётся кликабельной (можно щёлкать шестерёнки подряд).
  anchorLeft?: number;
}

export function HighlightEditor({ metricName, dataType, initial, onSave, onClose, displayMode, onDisplayModeChange, isPinned, onPinToggle, isAccented, onAccentToggle, isBar, onBarToggle, isHeatmap, onHeatmapToggle, isHeatmapInverted, onHeatmapInvertToggle, decimalPlaces, onDecimalPlacesChange, comparisonThreshold, onComparisonThresholdChange, anchorLeft }: Props) {
  const isPercent = dataType === 'percent';
  const thresholdLabel = isPercent ? 'До значения (%)' : 'До значения';
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  // Единая подсветка: Выкл / Градиент (авто, красный→зелёный) / Пороги (ручные)
  type HlMode = 'off' | 'gradient' | 'thresholds';
  const [hlMode, setHlMode] = useState<HlMode>(isHeatmap ? 'gradient' : (initial?.enabled ? 'thresholds' : 'off'));
  function switchMode(m: HlMode) {
    setHlMode(m);
    if (m === 'gradient' && !isHeatmap) onHeatmapToggle?.();
    if (m !== 'gradient' && isHeatmap) onHeatmapToggle?.();
    setEnabled(m === 'thresholds');
  }
  const [count, setCount] = useState(initial ? initial.thresholds.length + 1 : 2);
  const [thresholds, setThresholds] = useState<HighlightThreshold[]>(
    initial?.thresholds ?? defaultConfig(2).thresholds
  );
  const [aboveColor, setAboveColor] = useState(initial?.aboveColor ?? COLORS[0].value);
  const [scope, setScope] = useState<'report' | 'global'>('report');

  useEffect(() => {
    // Adjust thresholds array when count changes
    const needed = count - 1;
    if (thresholds.length < needed) {
      const extra = Array.from({ length: needed - thresholds.length }, (_, i) => ({
        value: (thresholds[thresholds.length - 1]?.value ?? 0) + (i + 1) * 10,
        color: COLORS[(thresholds.length + i) % COLORS.length].value,
      }));
      setThresholds(prev => [...prev, ...extra]);
    } else if (thresholds.length > needed) {
      setThresholds(prev => prev.slice(0, needed));
    }
  }, [count]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = enabled && thresholds.length > 0 ? thresholds[0].value : null;
  const previewColor = preview !== null ? (
    thresholds.find(t => (preview ?? 0) <= t.value)?.color ?? aboveColor
  ) : null;

  function handleSave() {
    if (!enabled) { onSave(null, scope); return; }
    onSave({ enabled: true, thresholds, aboveColor }, scope);
  }

  const docked = anchorLeft !== undefined;
  return (
    <>
      {/* Backdrop — только в режиме модалки; в док-режиме панель метрик остаётся кликабельной */}
      {!docked && <div className="fixed inset-0 z-40" onClick={onClose} />}
      {/* Slide panel */}
      <div
        className={`fixed inset-y-0 z-50 w-80 bg-[var(--color-bg-surface)] shadow-2xl flex flex-col animate-in duration-200 ${docked ? 'border-l border-[var(--color-border)] slide-in-from-left' : 'right-0 slide-in-from-right'}`}
        style={docked ? { left: anchorLeft } : undefined}>
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-[var(--color-border)]">
          <div>
            <div className="font-semibold text-[var(--color-text)] text-base">Настройки метрики</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{metricName}</div>
          </div>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors ml-2 mt-0.5">✕</button>
        </div>
        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">

        {/* Display mode + pin */}
        {(onDisplayModeChange || onPinToggle || onAccentToggle || onBarToggle || onHeatmapToggle) && (
          <div>
            <div className="text-xs text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wide">Отображение</div>
            <div className="flex flex-col gap-1">
              {onDisplayModeChange && DISPLAY_OPTIONS.map(opt => (
                <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="displayMode"
                    value={opt.value}
                    checked={displayMode === opt.value}
                    onChange={() => onDisplayModeChange(opt.value)}
                    className="accent-[var(--color-accent)]"
                  />
                  <span className="text-sm text-[var(--color-text)]">{opt.label}</span>
                </label>
              ))}
              {onPinToggle && (
                <label className="flex items-center gap-2 cursor-pointer mt-1 pt-1 border-t border-[var(--color-border)]">
                  <input
                    type="checkbox"
                    checked={isPinned ?? false}
                    onChange={onPinToggle}
                    className="accent-[var(--color-accent)] w-4 h-4"
                  />
                  <span className="text-sm text-[var(--color-text)]">Закрепить колонку слева</span>
                </label>
              )}
              {onAccentToggle && (
                <label className="flex items-center gap-2 cursor-pointer mt-1 pt-1 border-t border-[var(--color-border)]">
                  <input
                    type="checkbox"
                    checked={isAccented ?? false}
                    onChange={onAccentToggle}
                    className="accent-[var(--color-accent)] w-4 h-4"
                  />
                  <span className="text-sm text-[var(--color-text)] flex items-center gap-1.5">
                    Акцент колонки
                    <span className="text-[11px] text-[var(--color-text-muted)]">(жирный + фон)</span>
                  </span>
                </label>
              )}
              {onBarToggle && (
                <label className="flex items-center gap-2 cursor-pointer mt-1 pt-1 border-t border-[var(--color-border)]">
                  <input
                    type="checkbox"
                    checked={isBar ?? false}
                    onChange={onBarToggle}
                    className="accent-[var(--color-accent)] w-4 h-4"
                  />
                  <span className="text-sm text-[var(--color-text)] flex items-center gap-1.5">
                    Столбик в ячейке
                    <span className="text-[11px] text-[var(--color-text-muted)]">(бар по макс. в колонке)</span>
                  </span>
                </label>
              )}
            </div>
          </div>
        )}

        {/* Decimal places */}
        {onDecimalPlacesChange && (
          <div>
            <div className="text-xs text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wide">Формат числа</div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-[var(--color-text)]">Знаков после запятой</span>
              <div className="flex gap-1 ml-auto">
                {[0, 1, 2, 3].map(n => (
                  <button
                    key={n}
                    onClick={() => onDecimalPlacesChange(n)}
                    className={`w-8 h-8 rounded-full text-sm font-medium transition-colors ${
                      (decimalPlaces ?? 2) === n
                        ? 'bg-[var(--color-accent)] text-white'
                        : 'bg-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Comparison threshold */}
        {onComparisonThresholdChange && (
          <div>
            <div className="text-xs text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wide">Порог нейтральности (~)</div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={comparisonThreshold ?? 5}
                onChange={e => onComparisonThresholdChange(Number(e.target.value))}
                className="w-20 border border-[var(--color-border)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] text-[var(--color-text)]"
              />
              <span className="text-sm text-[var(--color-text-muted)]">% отклонение → ~</span>
            </div>
          </div>
        )}

        {/* Единая подсветка значений */}
        <div>
          <div className="text-xs text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wide">Подсветка значений</div>
          <div className="flex flex-col gap-1">
            {([
              { v: 'off',        label: 'Выключена' },
              { v: 'gradient',   label: 'Градиент (авто)', hint: 'красный → зелёный по min→max' },
              { v: 'thresholds', label: 'Пороги', hint: 'свои значения и цвета' },
            ] as { v: 'off' | 'gradient' | 'thresholds'; label: string; hint?: string }[]).map(o => (
              <label key={o.v} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="hlMode"
                  checked={hlMode === o.v}
                  onChange={() => switchMode(o.v)}
                  className="accent-[var(--color-accent)]"
                />
                <span className="text-sm text-[var(--color-text)]">
                  {o.label}
                  {o.hint && <span className="text-[11px] text-[var(--color-text-muted)] ml-1.5">({o.hint})</span>}
                </span>
              </label>
            ))}
          </div>
          {hlMode === 'gradient' && onHeatmapInvertToggle && (
            <label className="flex items-center gap-2 cursor-pointer mt-2 pl-6">
              <input
                type="checkbox"
                checked={isHeatmapInverted ?? false}
                onChange={onHeatmapInvertToggle}
                className="accent-[var(--color-accent)] w-4 h-4"
              />
              <span className="text-sm text-[var(--color-text)]">
                Наоборот
                <span className="text-[11px] text-[var(--color-text-muted)] ml-1.5">(меньше = лучше: минимум зелёный)</span>
              </span>
            </label>
          )}
        </div>

        {hlMode === 'thresholds' && (
          <>
            {/* Count */}
            <div>
              <div className="text-xs text-[var(--color-text-muted)] mb-1.5">Количество порогов</div>
              <div className="flex gap-1.5">
                {[2, 3, 4, 5].map(n => (
                  <button
                    key={n}
                    onClick={() => setCount(n)}
                    className={`w-8 h-8 rounded-full text-sm font-medium transition-colors ${
                      count === n
                        ? 'bg-[var(--color-accent)] text-white'
                        : 'bg-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Thresholds */}
            {thresholds.map((t, i) => (
              <div key={i} className="border border-[var(--color-border)] rounded-lg p-3 flex flex-col gap-2">
                <div className="text-xs text-[var(--color-text-muted)]">{thresholdLabel}</div>
                <input
                  type="number"
                  value={t.value}
                  onChange={e => setThresholds(prev => prev.map((p, j) => j === i ? { ...p, value: Number(e.target.value) } : p))}
                  className="w-full border border-[var(--color-border)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] text-[var(--color-text)]"
                />
                <ColorPicker value={t.color} onChange={c => setThresholds(prev => prev.map((p, j) => j === i ? { ...p, color: c } : p))} />
              </div>
            ))}

            {/* Above last threshold */}
            <div className="border border-[var(--color-border)] rounded-lg p-3 flex flex-col gap-2">
              <div className="text-xs text-[var(--color-accent)]">Выше последнего порога</div>
              <ColorPicker value={aboveColor} onChange={setAboveColor} />
            </div>

            {/* Preview */}
            <div className="flex justify-end text-xs text-[var(--color-text-muted)]">
              Пример:&nbsp;
              <span
                className="px-2 rounded"
                style={{ backgroundColor: previewColor ?? DEFAULT_COLOR }}
              >
                {preview ?? 50}
              </span>
            </div>
          </>
        )}

        {/* Scope */}
        <div className="flex flex-col gap-1">
          {(['report', 'global'] as const).map(s => (
            <label key={s} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="scope"
                value={s}
                checked={scope === s}
                onChange={() => setScope(s)}
                className="accent-[var(--color-accent)]"
              />
              <span className="text-sm text-[var(--color-text)]">
                {s === 'report' ? 'Только в этом отчёте' : 'Всегда (для меня)'}
              </span>
            </label>
          ))}
        </div>

        </div>
        {/* Footer */}
        <div className="px-5 py-4 border-t border-[var(--color-border)] flex justify-between items-center">
          <button
            onClick={() => { onSave(null, scope); }}
            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-negative)] transition-colors"
          >
            Сбросить
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 text-sm bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 transition-opacity"
          >
            Сохранить
          </button>
        </div>
      </div>
    </>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {COLORS.map(c => (
        <button
          key={c.value}
          title={c.label}
          onClick={() => onChange(c.value)}
          className="w-6 h-6 rounded-full transition-transform hover:scale-110"
          style={{
            backgroundColor: c.value,
            outline: value === c.value ? '2px solid var(--color-accent)' : '2px solid transparent',
            outlineOffset: 2,
          }}
        />
      ))}
    </div>
  );
}
