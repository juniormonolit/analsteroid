'use client';
import { Type } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import type { ComparisonDisplay, AccountType, BorderMode } from '@/lib/metrics/types';

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

export interface ViewSettingsFieldsProps {
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
  // «Зебра» (правка владельца 09.07): лёгкая полосатость чётных строк ReportTable.
  // По умолчанию выкл (undefined ⇒ false) — текущее поведение (вариант C без зебры).
  zebra?: boolean;
  onZebraChange?: (v: boolean) => void;
  // «Границы» (п.4 правок 09.07, встреча вечер): grid (дефолт) / horizontal / none —
  // см. ReportTable.borderMode. undefined ⇒ 'grid'.
  borderMode?: BorderMode;
  onBorderModeChange?: (v: BorderMode) => void;
}

// Содержимое «Вид» — вынесено из-под Popover-обёртки (правка 09.07), чтобы использовать
// И в самостоятельном дропдауне (ViewSettings ниже — дрилл-даун, toolbarExtras), И в
// объединённой панели «Настройки отчёта» (ReportSettingsPanel — правая колонка
// основного тулбара), без дублирования разметки/логики.
export function ViewSettingsFields({
  prefs, onChange, numberAlign, onNumberAlignChange,
  comparisonDisplay, hasMixedDisplay, onComparisonDisplayChange,
  accountType, onAccountTypeChange,
  drilldownGrouped, onDrilldownGroupedChange,
  colorizeMetrics, onColorizeMetricsChange,
  zebra, onZebraChange,
  borderMode, onBorderModeChange,
}: ViewSettingsFieldsProps) {
  const fontPct = Math.round(prefs.fontScale * 100);

  return (
      <div className="flex flex-col gap-3">
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
                options={['full', 'partial', 'compact', 'current'] as ComparisonDisplay[]}
                value={hasMixedDisplay ? undefined : comparisonDisplay}
                onChange={onComparisonDisplayChange}
                labels={{ full: 'Сравнение', partial: 'Частичное', compact: 'Компактн.', current: 'Текущий' }}
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

          {onZebraChange && (
            <div>
              <SectionLabel>Зебра</SectionLabel>
              <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
                {([true, false] as const).map(v => (
                  <button
                    key={String(v)}
                    onClick={() => onZebraChange(v)}
                    className={`flex-1 px-2 py-1.5 transition-colors ${(zebra ?? false) === v ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
                  >
                    {v ? 'Да' : 'Нет'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {onBorderModeChange && (
            <div>
              <SectionLabel>Границы</SectionLabel>
              <Seg
                options={['grid', 'horizontal', 'none'] as BorderMode[]}
                value={borderMode ?? 'grid'}
                onChange={onBorderModeChange}
                labels={{ grid: 'Сетка', horizontal: 'Гориз.', none: 'Без границ' }}
              />
            </div>
          )}

          <button
            onClick={() => onChange(DEFAULT_VIEW_PREFS)}
            className="text-xs text-[var(--color-accent)] hover:underline self-start"
          >
            Сбросить
          </button>
      </div>
  );
}

// Самостоятельный дропдаун «Вид» — используется там, где нужен независимый попап (сейчас
// это toolbarExtras дрилл-дауна, DrilldownDrawer, — там прочие настройки уже свои, а «Вид»
// разделяется с основным отчётом). В основном тулбаре отчёта (ReportToolbar) эта кнопка
// упразднена правкой 09.07 — см. ViewSettingsFields выше.
export function ViewSettings(props: ViewSettingsFieldsProps) {
  return (
    <Popover
      align="end"
      className="w-[260px] p-3"
      trigger={
        <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors">
          <Type size={12} />
          Вид
        </button>
      }
    >
      <ViewSettingsFields {...props} />
    </Popover>
  );
}
