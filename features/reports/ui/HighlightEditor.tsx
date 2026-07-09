'use client';
import { useState } from 'react';
import type { MetricHighlightConfig, HighlightThreshold } from '@/lib/saved-reports/types';
import type { ComparisonDisplay } from '@/lib/metrics/types';
import { GsColorPickerButton } from '@/components/ui/GsColorPicker';
import { GOOGLE_SHEETS_PALETTE_GRID, GS_TINT_ROWS } from '@/lib/colors/google-sheets-palette';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SlideBackdrop } from '@/components/ui/SlideBackdrop';
import { CONDITION_OPTIONS, GRADIENT_ZONE_SWATCHES, thresholdZoneSwatches } from '@/lib/reports/metricFilter';
import type { ConditionOp, MetricConditionFilter, MetricFilterState } from '@/lib/reports/metricFilter';

const DISPLAY_OPTIONS: { value: ComparisonDisplay; label: string }[] = [
  { value: 'full',    label: 'Полное сравнение' },
  { value: 'partial', label: 'Частичное (без Δ)' },
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
  // Немедленная очистка сохранённого порогового конфига метрики (report-scope), в обход
  // кнопки «Сохранить». Без этого переключение радиокнопки в «Выключена»/«Градиент» гасит
  // heatmap-флаг мгновенно (onHeatmapToggle), а старый threshold-конфиг остаётся висеть до
  // явного клика «Сохранить» — асимметрия, из-за которой «выключенная» подсветка на деле
  // не выключается, пока пользователь не нажмёт Save (баг из аудита 2026-07-09).
  onThresholdsClear?: () => void;
  decimalPlaces?: number;
  onDecimalPlacesChange?: (v: number) => void;
  comparisonThreshold?: number;
  onComparisonThresholdChange?: (v: number) => void;
  // Док-режим: редактор прижимается к left=anchorLeft (справа от панели метрик),
  // без бэкдропа — панель остаётся кликабельной (можно щёлкать шестерёнки подряд).
  anchorLeft?: number;
  // Положение метрики среди колонок отчёта и удаление из отчёта — переехали сюда из
  // упразднённого контекстного меню шестерёнки (MetricMenu, правка владельца 09.07):
  // раньше «Настроить»/←/→/«Убрать» были пунктами меню, теперь шестерёнка сразу
  // открывает эту панель, а ←/→/«Убрать» — секция «Положение и удаление» ниже.
  isFirst?: boolean;
  isLast?: boolean;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
  onRemove?: () => void;
  // Фильтр по цвету/условию + сортировка по цвету (правка владельца 09.07, «Фильтр и
  // сортировка» под подсветкой) — сессионное состояние (SalesReportPage), применяется
  // сразу (не гейтится «Сохранить»), как и pin/accent/bar/heatmap-тумблеры выше.
  filterState?: MetricFilterState;
  onColorZoneChange?: (zone: string | null) => void;
  onConditionChange?: (cond: MetricConditionFilter | null) => void;
  onSortByColorToggle?: () => void;
  onFilterReset?: () => void;
}

export function HighlightEditor({ metricName, dataType, initial, onSave, onClose, displayMode, onDisplayModeChange, isPinned, onPinToggle, isAccented, onAccentToggle, isBar, onBarToggle, isHeatmap, onHeatmapToggle, isHeatmapInverted, onHeatmapInvertToggle, onThresholdsClear, decimalPlaces, onDecimalPlacesChange, comparisonThreshold, onComparisonThresholdChange, anchorLeft, isFirst, isLast, onMoveLeft, onMoveRight, onRemove, filterState, onColorZoneChange, onConditionChange, onSortByColorToggle, onFilterReset }: Props) {
  const isPercent = dataType === 'percent';
  const thresholdLabel = isPercent ? 'До значения (%)' : 'До значения';
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  // Единая подсветка: Выкл / Градиент (авто, красный→зелёный) / Пороги (ручные)
  type HlMode = 'off' | 'gradient' | 'thresholds';
  const [hlMode, setHlMode] = useState<HlMode>(isHeatmap ? 'gradient' : (initial?.enabled ? 'thresholds' : 'off'));
  // Режимы взаимоисключающие (off/gradient/thresholds) — переключение ПРИМЕНЯЕТСЯ сразу,
  // а не после «Сохранить»: heatmap-флаг и так гасился мгновенно (onHeatmapToggle), а
  // пороговый конфиг раньше отставал до Save — отсюда «выключил подсветку, а бейдж
  // остался цветным». Теперь при уходе из 'thresholds' сразу чистим прошлый пороговый
  // конфиг (onThresholdsClear), при входе в 'gradient'/'thresholds' — гасим heatmap-флаг
  // на противоположном режиме. Итог: ни одна метрика не может одновременно иметь активный
  // heatmap-флаг И активный threshold-конфиг.
  function switchMode(m: HlMode) {
    setHlMode(m);
    if (m === 'gradient' && !isHeatmap) onHeatmapToggle?.();
    if (m !== 'gradient' && isHeatmap) onHeatmapToggle?.();
    if (m !== 'thresholds') onThresholdsClear?.();
    setEnabled(m === 'thresholds');
    // Ключи зон цвета разные в градиенте ('red'/'yellow'/'green') и порогах ('0'..'N-1'/
    // 'above') — при смене режима старый выбор зоны либо бессмысленен, либо (что хуже)
    // случайно совпадёт по строке с зоной из другого режима. Сбрасываем фильтр по цвету
    // сразу, чтобы «Выключить подсветку» не оставляло фильтр, из-за которого таблица
    // вдруг показывает 0 строк без видимой причины.
    onColorZoneChange?.(null);
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

  // Обёртка секции: в доке — компактная (как раньше, узкая колонка рядом с панелью
  // метрик), в модалке — широкая карточка с разделителем снизу (макет
  // metric-settings-redesign.html, вариант C). Ширина/2-колоночность задаются
  // контейнером ниже, эта обёртка только про паддинги/разделители одной секции.
  function SectionBlock({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
    if (docked) {
      return (
        <div>
          <div className="text-xs text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wide">{eyebrow}</div>
          {children}
        </div>
      );
    }
    return (
      <div className="px-6 sm:px-7 py-5 sm:py-6 border-b border-[var(--color-border)] last:border-b-0">
        <div className="text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-wide mb-4">{eyebrow}</div>
        {children}
      </div>
    );
  }

  const displaySection = onDisplayModeChange && (
    <SectionBlock eyebrow="Отображение">
      <div className="grid grid-cols-2 gap-2.5">
        {DISPLAY_OPTIONS.map(opt => {
          const selected = displayMode === opt.value;
          return (
            <label
              key={opt.value}
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-3 cursor-pointer transition-colors ${
                selected
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                  : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              <input
                type="radio"
                name="displayMode"
                value={opt.value}
                checked={selected}
                onChange={() => onDisplayModeChange(opt.value)}
                className="accent-[var(--color-accent)] shrink-0"
              />
              <span className="text-sm font-medium text-[var(--color-text)] leading-snug">{opt.label}</span>
            </label>
          );
        })}
      </div>
    </SectionBlock>
  );

  const optionRows: { key: string; checked: boolean; onChange: () => void; title: string; hint: string }[] = [];
  if (onPinToggle) optionRows.push({ key: 'pin', checked: isPinned ?? false, onChange: onPinToggle, title: 'Закрепить колонку слева', hint: 'Остаётся видимой при горизонтальной прокрутке таблицы' });
  if (onAccentToggle) optionRows.push({ key: 'accent', checked: isAccented ?? false, onChange: onAccentToggle, title: 'Акцент колонки', hint: 'Жирный текст и выделение фоном среди остальных метрик' });
  if (onBarToggle) optionRows.push({ key: 'bar', checked: isBar ?? false, onChange: onBarToggle, title: 'Столбик в ячейке', hint: 'Мини-диаграмма прогресса по максимуму в колонке' });

  const optionsSection = optionRows.length > 0 && (
    <SectionBlock eyebrow="Дополнительные опции">
      <div className="flex flex-col gap-3.5">
        {optionRows.map(row => (
          <label key={row.key} className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={row.checked}
              onChange={row.onChange}
              className="accent-[var(--color-accent)] w-4 h-4 mt-0.5 shrink-0"
            />
            <span>
              <span className="block text-sm font-medium text-[var(--color-text)]">{row.title}</span>
              <span className="block text-xs text-[var(--color-text-muted)] mt-0.5 leading-snug">{row.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </SectionBlock>
  );

  const formatSection = onDecimalPlacesChange && (
    <SectionBlock eyebrow="Формат числа">
      <div className="text-sm font-medium text-[var(--color-text)] mb-3">Знаков после запятой</div>
      <div className="flex gap-1.5">
        {[0, 1, 2, 3].map(n => (
          <button
            key={n}
            onClick={() => onDecimalPlacesChange(n)}
            className={`w-9 h-9 rounded-full text-sm font-semibold transition-colors ${
              (decimalPlaces ?? 2) === n
                ? 'bg-[var(--color-accent)] text-white'
                : 'bg-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
    </SectionBlock>
  );

  const neutralitySection = onComparisonThresholdChange && (
    <SectionBlock eyebrow="Порог нейтральности (~)">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 border border-[var(--color-border)] rounded-lg px-3 py-2 shrink-0">
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={comparisonThreshold ?? 5}
            onChange={e => onComparisonThresholdChange(Number(e.target.value))}
            className="w-14 text-sm font-semibold text-[var(--color-text)] bg-transparent outline-none"
          />
          <span className="text-sm text-[var(--color-text-muted)]">%</span>
        </div>
        <span className="text-xs text-[var(--color-text-muted)] leading-snug flex-1 min-w-[140px]">
          Отклонения меньше этого% считаются нейтральными и красятся серым
        </span>
      </div>
    </SectionBlock>
  );

  // Положение и удаление — бывшие пункты MetricMenu (←/→/«Убрать»), упразднённого
  // 09.07: шестерёнка в заголовке метрики теперь сразу ведёт сюда, а не в промежуточное
  // меню. Крайние метрики — стрелка к краю задизейблена (та же логика opacity-30, что
  // была в меню).
  const positionSection = (onMoveLeft || onMoveRight || onRemove) && (
    <SectionBlock eyebrow="Положение и удаление">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {(onMoveLeft || onMoveRight) && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onMoveLeft}
              disabled={!onMoveLeft || isFirst}
              title="Переместить влево"
              className={`w-9 h-9 flex items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors ${(!onMoveLeft || isFirst) ? 'opacity-30 cursor-not-allowed' : ''}`}
            >
              ←
            </button>
            <button
              type="button"
              onClick={onMoveRight}
              disabled={!onMoveRight || isLast}
              title="Переместить вправо"
              className={`w-9 h-9 flex items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors ${(!onMoveRight || isLast) ? 'opacity-30 cursor-not-allowed' : ''}`}
            >
              →
            </button>
          </div>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-sm font-semibold text-[var(--color-negative)] hover:underline"
          >
            Убрать из отчёта
          </button>
        )}
      </div>
    </SectionBlock>
  );

  const highlightSection = (
    <SectionBlock eyebrow="Подсветка значений">
      {!docked && (
        <p className="text-xs text-[var(--color-text-muted)] leading-relaxed mb-4 -mt-2">
          Красит бейдж (плашку) вокруг значения — фон ячейки остаётся белым. Режимы взаимоисключающие: выбирается только один.
        </p>
      )}
      <div className="flex bg-[var(--color-bg)] rounded-xl p-1 gap-1 mb-4">
        {([
          { v: 'off', label: 'Выключено' },
          { v: 'gradient', label: 'Градиент' },
          { v: 'thresholds', label: 'Пороги' },
        ] as { v: HlMode; label: string }[]).map(o => (
          <button
            key={o.v}
            type="button"
            onClick={() => switchMode(o.v)}
            className={`flex-1 text-center px-2 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
              hlMode === o.v ? 'bg-[var(--color-accent)] text-white shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      {hlMode === 'gradient' && onHeatmapInvertToggle && (
        <label className="flex items-center gap-2 cursor-pointer mb-1">
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

      {hlMode === 'thresholds' && (
        <>
          {/* Thresholds — любое количество (≥1, вместе с «выше последнего» = ≥2 точки).
              Между соседними точками цвет плавно перетекает градиентом. */}
          <div className="text-xs text-[var(--color-text-muted)] mb-3">
            Пороги ({thresholds.length + 1} {thresholds.length + 1 === 1 ? 'точка' : 'точек'} на градиенте)
          </div>
          <div className="flex flex-col gap-2.5">
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
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={t.value}
                    onChange={e => setThresholds(prev => prev.map((p, j) => j === i ? { ...p, value: Number(e.target.value) } : p))}
                    className="flex-1 border border-[var(--color-border)] rounded px-2 py-1.5 text-sm bg-[var(--color-bg)] text-[var(--color-text)]"
                  />
                  <GsColorPickerButton value={t.color} onChange={c => setThresholds(prev => prev.map((p, j) => j === i ? { ...p, color: c } : p))} />
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={addThreshold}
            className="mt-2.5 text-xs font-semibold text-[var(--color-accent)] hover:underline self-start"
          >
            + Добавить порог
          </button>

          {/* Above last threshold */}
          <div className="border border-[var(--color-border)] rounded-lg p-3 flex flex-col gap-2 mt-3">
            <div className="text-xs text-[var(--color-accent)] font-medium">Выше последнего порога</div>
            <GsColorPickerButton value={aboveColor} onChange={setAboveColor} />
          </div>

          {/* Preview */}
          <div className="flex justify-end text-xs text-[var(--color-text-muted)] mt-3">
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
    </SectionBlock>
  );

  // «Фильтр и сортировка» (правка владельца 09.07): фильтр по цвету текущей подсветки
  // (свотчи опорных цветов режима + «все»), фильтр по условию (значение метрики), и
  // сортировка строк по цветовой зоне. Сессионное состояние — применяется сразу через
  // колбэки, без «Сохранить» (см. filterState в SalesReportPage). Фильтр по цвету
  // недоступен, пока подсветка выключена (hlMode === 'off') — иначе зона неопределена.
  const zoneSwatches: { key: string; color: string; label: string }[] = hlMode === 'gradient'
    ? GRADIENT_ZONE_SWATCHES
    : hlMode === 'thresholds'
      ? thresholdZoneSwatches({ thresholds, aboveColor }).map(z => ({
          ...z,
          label: z.key === 'above' ? 'Выше последнего порога' : `Порог #${Number(z.key) + 1}`,
        }))
      : [];
  const colorFilterAvailable = hlMode !== 'off';
  const hasFilter = onColorZoneChange || onConditionChange || onSortByColorToggle;

  const filterSection = hasFilter && (
    <SectionBlock eyebrow="Фильтр и сортировка">
      <div className="flex flex-col gap-4">
        {onColorZoneChange && (
          <div>
            <div className="text-sm font-medium text-[var(--color-text)] mb-2">Фильтр по цвету</div>
            {!colorFilterAvailable ? (
              <div className="text-xs text-[var(--color-text-muted)]">Включите подсветку, чтобы фильтровать по цвету</div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => onColorZoneChange(null)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                    !filterState?.colorZone
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'
                  }`}
                >
                  Все
                </button>
                {zoneSwatches.map(z => (
                  <button
                    key={z.key}
                    type="button"
                    title={z.label}
                    onClick={() => onColorZoneChange(filterState?.colorZone === z.key ? null : z.key)}
                    className={`w-7 h-7 rounded-full border-2 transition-transform ${
                      filterState?.colorZone === z.key ? 'border-[var(--color-accent)] scale-110' : 'border-transparent hover:scale-105'
                    }`}
                    style={{ backgroundColor: z.color }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {onConditionChange && (
          <div>
            <div className="text-sm font-medium text-[var(--color-text)] mb-2">Фильтр по условию</div>
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={filterState?.condition?.op ?? ''}
                onChange={e => {
                  const op = e.target.value as ConditionOp | '';
                  if (!op) { onConditionChange(null); return; }
                  onConditionChange({ op, value: filterState?.condition?.value ?? 0, value2: filterState?.condition?.value2 });
                }}
                className="border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm bg-[var(--color-bg)] text-[var(--color-text)]"
              >
                <option value="">Без условия</option>
                {CONDITION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {filterState?.condition && (
                <>
                  <input
                    type="number"
                    value={filterState.condition.value}
                    onChange={e => onConditionChange({ ...filterState.condition!, value: Number(e.target.value) })}
                    className="w-20 border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm bg-[var(--color-bg)] text-[var(--color-text)]"
                  />
                  {filterState.condition.op === 'between' && (
                    <>
                      <span className="text-xs text-[var(--color-text-muted)]">и</span>
                      <input
                        type="number"
                        value={filterState.condition.value2 ?? filterState.condition.value}
                        onChange={e => onConditionChange({ ...filterState.condition!, value2: Number(e.target.value) })}
                        className="w-20 border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm bg-[var(--color-bg)] text-[var(--color-text)]"
                      />
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {onSortByColorToggle && (
          <label className={`flex items-center gap-2 ${colorFilterAvailable ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
            <input
              type="checkbox"
              checked={filterState?.sortByColor ?? false}
              onChange={onSortByColorToggle}
              disabled={!colorFilterAvailable}
              className="accent-[var(--color-accent)] w-4 h-4"
            />
            <span className={`text-sm ${colorFilterAvailable ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}>
              Сортировать по цвету
              <span className="text-[11px] text-[var(--color-text-muted)] ml-1.5">(лучшая зона сверху)</span>
            </span>
          </label>
        )}

        {onFilterReset && (filterState?.colorZone || filterState?.condition || filterState?.sortByColor) && (
          <button
            type="button"
            onClick={onFilterReset}
            className="text-xs font-semibold text-[var(--color-negative)] hover:underline self-start"
          >
            Сбросить фильтр
          </button>
        )}
      </div>
    </SectionBlock>
  );

  const scopeSwitch = (
    <div className={docked ? '' : 'flex-1 min-w-0'}>
      <div className={`text-xs text-[var(--color-text-muted)] mb-2 ${docked ? 'uppercase tracking-wide' : 'font-semibold'}`}>Область применения</div>
      <div className={`flex bg-[var(--color-bg)] rounded-lg p-1 gap-1 ${docked ? 'flex-col' : 'max-w-sm'}`}>
        {(['report', 'global'] as const).map(s => (
          <button
            key={s}
            type="button"
            onClick={() => setScope(s)}
            className={`flex-1 text-center px-3 py-2 rounded-md text-xs font-semibold transition-colors ${
              scope === s ? 'bg-[var(--color-bg-surface)] text-[var(--color-accent)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            {s === 'report' ? 'Только в этом отчёте' : 'Всегда (для меня)'}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
      {/* Backdrop — только в режиме модалки; в док-режиме панель метрик остаётся кликабельной */}
      {!docked && <SlideBackdrop closing={closing} onClick={requestClose} />}
      {/* Slide panel — доке узкая (как раньше), модалка широкая (~48vw, мин. 680px,
          макет metric-settings-redesign.html), схлопывается в одну колонку до sm:. */}
      <div
        className={`fixed inset-y-0 z-50 bg-[var(--color-bg-surface)] shadow-2xl flex flex-col ${closing ? exitAnim : enterAnim} ${
          docked ? 'w-80 max-w-[94vw] border-l border-[var(--color-border)]' : 'right-0 w-full sm:w-[48vw] sm:min-w-[680px] sm:max-w-[960px]'
        }`}
        style={docked ? { left: anchorLeft } : undefined}>
        {!docked && <PanelCloseTab onClick={requestClose} />}
        {/* Header */}
        <div className="flex items-start justify-between px-5 sm:px-8 pt-5 sm:pt-6 pb-4 sm:pb-5 border-b border-[var(--color-border)]">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-0.5">Настройки метрики</div>
            <div className="font-semibold text-[var(--color-text)] text-base sm:text-lg">{metricName}</div>
          </div>
          <button onClick={requestClose} className={`${docked ? '' : 'sm:hidden'} text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors ml-2 mt-0.5`}>✕</button>
        </div>

        {/* Body: доке — одна узкая колонка (как раньше); модалка — 2 колонки, схлопываются в 1 на мобиле */}
        <div className={docked ? 'flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5' : 'flex-1 overflow-y-auto flex flex-col sm:flex-row'}>
          <div className={docked ? 'flex flex-col gap-5' : 'flex flex-col sm:w-1/2 sm:border-r sm:border-[var(--color-border)]'}>
            {displaySection}
            {optionsSection}
            {formatSection}
            {neutralitySection}
            {positionSection}
          </div>
          <div className={docked ? 'flex flex-col gap-5' : 'flex flex-col sm:w-1/2'}>
            {highlightSection}
            {filterSection}
          </div>
        </div>

        {/* Footer: область применения + действия — на всю ширину */}
        <div className="px-5 sm:px-8 py-4 sm:py-5 border-t border-[var(--color-border)] flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          {scopeSwitch}
          <div className="flex justify-end gap-2.5 shrink-0">
            <button
              onClick={() => {
                // «Сбросить» = полностью «Выключена»: гасим оба канала подсветки, не только
                // пороги — иначе градиент мог остаться активным после сброса порогов.
                if (isHeatmap) onHeatmapToggle?.();
                onSave(null, scope);
              }}
              className="px-4 py-2 text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-negative)] border border-[var(--color-border)] rounded-lg transition-colors"
            >
              Сбросить
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm font-semibold bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 transition-opacity"
            >
              Сохранить
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
