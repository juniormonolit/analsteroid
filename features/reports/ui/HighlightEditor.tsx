'use client';
import { useState } from 'react';
import type { MetricHighlightConfig, HighlightThreshold } from '@/lib/saved-reports/types';
import type { ComparisonDisplay } from '@/lib/metrics/types';
import { GsColorPickerButton } from '@/components/ui/GsColorPicker';
import { GOOGLE_SHEETS_PALETTE_GRID, GS_TINT_ROWS } from '@/lib/colors/google-sheets-palette';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';

const DISPLAY_OPTIONS: { value: ComparisonDisplay; label: string }[] = [
  { value: 'full',    label: 'Полное сравнение' },
  { value: 'current', label: 'Только текущий' },
  { value: 'compact', label: 'Компактное' },
];

// Стартовые цвета для новых порогов — пастельные тона из палитры Google Sheets
// (п.10 спеки), по кругу: красный/оранжевый/жёлтый/зелёный/синий/серый. Пользователь
// свободно меняет любой цвет через GsColorPickerButton (вся палитра, не только эти 6).
const DEFAULT_STOP_COLORS: readonly string[] = [
  GS_TINT_ROWS[4][1], // красный
  GS_TINT_ROWS[4][2], // оранжевый
  GS_TINT_ROWS[4][3], // жёлтый
  GS_TINT_ROWS[4][4], // зелёный
  GS_TINT_ROWS[4][6], // синий
  GOOGLE_SHEETS_PALETTE_GRID[0][6], // серый
];
const DEFAULT_COLOR = GOOGLE_SHEETS_PALETTE_GRID[0][6];

function defaultConfig(thresholdCount: number): MetricHighlightConfig {
  const thresholds: HighlightThreshold[] = Array.from({ length: thresholdCount - 1 }, (_, i) => ({
    value: (i + 1) * 10,
    color: DEFAULT_STOP_COLORS[i % DEFAULT_STOP_COLORS.length],
  }));
  return { enabled: true, thresholds, aboveColor: DEFAULT_STOP_COLORS[thresholdCount - 1 < DEFAULT_STOP_COLORS.length ? thresholdCount - 1 : 0] };
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
  const [thresholds, setThresholds] = useState<HighlightThreshold[]>(
    initial?.thresholds ?? defaultConfig(2).thresholds
  );
  const [aboveColor, setAboveColor] = useState(initial?.aboveColor ?? DEFAULT_STOP_COLORS[0]);
  const [scope, setScope] = useState<'report' | 'global'>('report');

  // Произвольное число порогов (≥1, т.е. ≥2 цветовых точек вместе с aboveColor) —
  // раньше было жёстко [2,3,4,5] кнопками. Между соседними порогами — плавный градиент
  // (интерполяция в resolveHighlightColor/ReportTable.tsx), это не влияет на добавление/
  // удаление точек здесь.
  function addThreshold() {
    setThresholds(prev => [
      ...prev,
      {
        value: (prev[prev.length - 1]?.value ?? 0) + 10,
        color: DEFAULT_STOP_COLORS[prev.length % DEFAULT_STOP_COLORS.length],
      },
    ]);
  }
  function removeThreshold(i: number) {
    setThresholds(prev => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));
  }

  const preview = enabled && thresholds.length > 0 ? thresholds[0].value : null;
  const previewColor = preview !== null ? (
    thresholds.find(t => (preview ?? 0) <= t.value)?.color ?? aboveColor
  ) : null;

  function handleSave() {
    if (!enabled) { onSave(null, scope); return; }
    onSave({ enabled: true, thresholds, aboveColor }, scope);
  }

  const docked = anchorLeft !== undefined;
  const { closing, requestClose } = useSlideClose(onClose);
  // Докед слайдит слева направо (панель растёт вправо от якоря) — свой enter/exit;
  // модалка (не докед) слайдит справа, как остальные слайд-панели.
  const enterAnim = docked ? 'slide-panel-in-left' : 'slide-panel-in-right';
  const exitAnim = docked ? 'slide-panel-out-left' : 'slide-panel-out-right';
  return (
    <>
      {/* Backdrop — только в режиме модалки; в док-режиме панель метрик остаётся кликабельной */}
      {!docked && (
        <div
          className={`fixed inset-0 z-40 transition-opacity duration-150 ${closing ? 'opacity-0' : 'opacity-100'}`}
          onClick={requestClose}
        />
      )}
      {/* Slide panel */}
      <div
        className={`fixed inset-y-0 z-50 w-80 max-w-[94vw] bg-[var(--color-bg-surface)] shadow-2xl flex flex-col ${closing ? exitAnim : enterAnim} ${docked ? 'border-l border-[var(--color-border)]' : 'right-0'}`}
        style={docked ? { left: anchorLeft } : undefined}>
        {!docked && <PanelCloseTab onClick={requestClose} />}
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-[var(--color-border)]">
          <div>
            <div className="font-semibold text-[var(--color-text)] text-base">Настройки метрики</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{metricName}</div>
          </div>
          <button onClick={requestClose} className={`${docked ? '' : 'sm:hidden'} text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors ml-2 mt-0.5`}>✕</button>
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
            {/* Thresholds — любое количество (≥1, вместе с «выше последнего» = ≥2 точки).
                Между соседними точками цвет плавно перетекает градиентом. */}
            <div className="text-xs text-[var(--color-text-muted)] -mb-1">
              Пороги ({thresholds.length + 1} {thresholds.length + 1 === 1 ? 'точка' : 'точек'} на градиенте)
            </div>
            {thresholds.map((t, i) => (
              <div key={i} className="border border-[var(--color-border)] rounded-lg p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-[var(--color-text-muted)]">{thresholdLabel}</div>
                  <button
                    onClick={() => removeThreshold(i)}
                    disabled={thresholds.length <= 1}
                    title="Удалить порог"
                    className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-negative)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    ✕
                  </button>
                </div>
                <input
                  type="number"
                  value={t.value}
                  onChange={e => setThresholds(prev => prev.map((p, j) => j === i ? { ...p, value: Number(e.target.value) } : p))}
                  className="w-full border border-[var(--color-border)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] text-[var(--color-text)]"
                />
                <GsColorPickerButton value={t.color} onChange={c => setThresholds(prev => prev.map((p, j) => j === i ? { ...p, color: c } : p))} />
              </div>
            ))}

            <button
              onClick={addThreshold}
              className="text-xs text-[var(--color-accent)] hover:underline self-start"
            >
              + Добавить порог
            </button>

            {/* Above last threshold */}
            <div className="border border-[var(--color-border)] rounded-lg p-3 flex flex-col gap-2">
              <div className="text-xs text-[var(--color-accent)]">Выше последнего порога</div>
              <GsColorPickerButton value={aboveColor} onChange={setAboveColor} />
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
