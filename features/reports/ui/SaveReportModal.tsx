'use client';
import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { SavedReportInput, RelativePeriod, ComparisonMode, PeriodMode, PeriodAnchor, PeriodUnit } from '@/lib/saved-reports/types';
import type { DealScope, ClientType, Grouping, ProductGroupMode, ComparisonDisplay } from '@/lib/metrics/types';
import type { DateRange } from '@/lib/period';
import { format } from 'date-fns';

const ANCHOR_OPTIONS: { value: PeriodAnchor; label: string }[] = [
  { value: 'current', label: 'Текущий' },
  { value: 'previous', label: 'Прошлый' },
];
const UNIT_OPTIONS: { value: PeriodUnit; label: string }[] = [
  { value: 'day', label: 'День' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'quarter', label: 'Квартал' },
  { value: 'year', label: 'Год' },
];
const COMPARISON_OPTIONS: { value: ComparisonMode; label: string; desc: string }[] = [
  { value: 'analogous', label: 'К аналогичному', desc: 'Тот же тип периода, шаг назад' },
  { value: 'previous_tail', label: 'К предыдущему', desc: 'То же кол-во дней до начала периода' },
];

interface Props {
  reportSlug: string;
  metricIds: string[];
  dealScope: DealScope;
  clientType: ClientType;
  grouping: Grouping;
  comparisonDisplay: ComparisonDisplay;
  metricDisplayModes: Record<string, ComparisonDisplay>;
  comparisonThreshold: number;
  productGroupMode: ProductGroupMode;
  departmentIds: string[];
  highlights: Record<string, import('@/lib/saved-reports/types').MetricHighlightConfig>;
  pinnedMetricIds: string[];
  metricDecimalOverrides: Record<string, number>;
  metricThresholdOverrides: Record<string, number>;
  accentedMetricIds: string[];
  barMetricIds: string[];
  heatmapMetricIds: string[];
  themeAccent: string | null;
  numberAlign: 'left' | 'center' | 'right';
  accountType: 'managers' | 'logists' | 'all';
  drilldownDuplicate: boolean;
  drilldownMetricIds: string[];
  dealFields?: string[];
  drilldownGrouped?: boolean;
  sourceDimension?: string;
  drilldownDimension?: string;
  sortBy: string | null;
  sortDir: 'asc' | 'desc';
  columnGroups: { name: string; metricIds: string[] }[];
  currentPeriod: DateRange;
  currentComparison: DateRange;
  onSave: (name: string, input: SavedReportInput) => Promise<void>;
  onClose: () => void;
}

export function SaveReportModal({
  reportSlug, metricIds, dealScope, clientType, grouping, comparisonDisplay,
  metricDisplayModes, comparisonThreshold,
  productGroupMode, departmentIds, highlights,
  pinnedMetricIds, metricDecimalOverrides, metricThresholdOverrides,
  accentedMetricIds, barMetricIds, heatmapMetricIds, themeAccent, numberAlign, accountType,
  drilldownDuplicate, drilldownMetricIds, dealFields, drilldownGrouped,
  sourceDimension, drilldownDimension,
  sortBy, sortDir, columnGroups,
  currentPeriod, currentComparison,
  onSave, onClose,
}: Props) {
  const [name, setName] = useState('');
  const [periodMode, setPeriodMode] = useState<PeriodMode>('relative');
  const [anchor, setAnchor] = useState<PeriodAnchor>('current');
  const [unit, setUnit] = useState<PeriodUnit>('month');
  const [compMode, setCompMode] = useState<ComparisonMode>('previous_tail');
  const [saving, setSaving] = useState(false);
  const [existingReports, setExistingReports] = useState<{ id: string; name: string; isShared?: boolean }[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    fetch('/api/saved-reports')
      .then(r => r.json())
      .then((data: { id: string; name: string; isShared?: boolean }[]) => setExistingReports(data))
      .catch(() => {});
    fetch('/api/auth/session')
      .then(r => r.json())
      .then((d: { user?: { isAdmin?: boolean } }) => setIsAdmin(!!d.user?.isAdmin))
      .catch(() => {});
  }, []);

  const existing = existingReports.find(r => r.name === name.trim());
  const willOverwrite = !!existing;
  // При перезаписи общего отчёта галка подхватывается автоматически
  useEffect(() => { if (existing?.isShared) setShared(true); }, [existing?.isShared]);

  const relativePeriod: RelativePeriod = { anchor, unit };

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    const input: SavedReportInput = {
      reportSlug,
      name: name.trim(),
      metricIds,
      dealScope,
      clientType,
      grouping,
      comparisonDisplay,
      productGroupMode,
      departmentIds,
      metricHighlights: highlights,
      metricDisplayModes,
      comparisonThreshold,
      pinnedMetricIds,
      metricDecimalOverrides,
      metricThresholdOverrides,
      accentedMetricIds,
      barMetricIds,
      heatmapMetricIds,
      themeAccent,
      numberAlign,
      accountType,
      drilldownDuplicateMetrics: drilldownDuplicate,
      drilldownMetricIds,
      dealFields,
      drilldownGrouped,
      sourceDimension,
      drilldownDimension,
      isShared: isAdmin ? shared : false,
      sortBy,
      sortDir,
      columnGroups,
      periodMode,
      relativePeriod: periodMode === 'relative' ? relativePeriod : null,
      comparisonMode: compMode,
      fixedPeriod: periodMode === 'fixed'
        ? { from: currentPeriod.from.toISOString(), to: currentPeriod.to.toISOString() }
        : null,
      fixedComparison: periodMode === 'fixed'
        ? { from: currentComparison.from.toISOString(), to: currentComparison.to.toISOString() }
        : null,
    };
    await onSave(name.trim(), input);
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-surface)] rounded-2xl shadow-2xl w-[460px] flex flex-col gap-5 p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="font-semibold text-[var(--color-text)] text-base">Сохранить отчёт</div>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            <X size={18} />
          </button>
        </div>

        {/* Name */}
        <div className="flex flex-col gap-1.5">
          <input
            autoFocus
            placeholder="Название отчёта"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            className="w-full border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            list="existing-reports-list"
          />
          <datalist id="existing-reports-list">
            {existingReports.map(r => <option key={r.id} value={r.name} />)}
          </datalist>
          {willOverwrite && (
            <div className="text-xs text-[var(--color-warning,#f59e0b)]">
              Отчёт с таким названием уже существует — конфигурация будет перезаписана
            </div>
          )}
          {isAdmin && (
            <label className="flex items-center gap-2 cursor-pointer mt-1">
              <input
                type="checkbox"
                checked={shared}
                onChange={e => setShared(e.target.checked)}
                className="accent-[var(--color-accent)] w-4 h-4"
              />
              <span className="text-sm text-[var(--color-text)]">
                В «Смекалочную»
                <span className="text-xs text-[var(--color-text-muted)] ml-1.5">(видна всем пользователям)</span>
              </span>
            </label>
          )}
        </div>

        {/* Period mode */}
        <div>
          <div className="text-xs font-medium text-[var(--color-text-muted)] mb-2 uppercase tracking-wider">Период</div>
          <div className="flex gap-2 mb-3">
            {(['relative', 'fixed'] as PeriodMode[]).map(m => (
              <button
                key={m}
                onClick={() => setPeriodMode(m)}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                  periodMode === m
                    ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                }`}
              >
                {m === 'relative' ? 'Относительный' : 'Фиксированный'}
              </button>
            ))}
          </div>

          {periodMode === 'relative' ? (
            <div className="flex gap-2">
              <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm">
                {ANCHOR_OPTIONS.map(o => (
                  <button
                    key={o.value}
                    onClick={() => setAnchor(o.value)}
                    className={`px-3 py-1.5 transition-colors ${
                      anchor === o.value ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm">
                {UNIT_OPTIONS.map(o => (
                  <button
                    key={o.value}
                    onClick={() => setUnit(o.value)}
                    className={`px-3 py-1.5 transition-colors ${
                      unit === o.value ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-sm text-[var(--color-text-muted)] bg-[var(--color-bg)] rounded-lg px-3 py-2">
              {format(currentPeriod.from, 'dd.MM.yyyy')} — {format(currentPeriod.to, 'dd.MM.yyyy')}
            </div>
          )}
        </div>

        {/* Comparison */}
        <div>
          <div className="text-xs font-medium text-[var(--color-text-muted)] mb-2 uppercase tracking-wider">Сравнение</div>
          <div className="flex flex-col gap-1.5">
            {COMPARISON_OPTIONS.map(o => (
              <label key={o.value} className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  name="compMode"
                  value={o.value}
                  checked={compMode === o.value}
                  onChange={() => setCompMode(o.value)}
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <div>
                  <div className="text-sm text-[var(--color-text)]">{o.label}</div>
                  <div className="text-xs text-[var(--color-text-muted)]">{o.desc}</div>
                </div>
              </label>
            ))}
            {periodMode === 'fixed' && (
              <div className="text-xs text-[var(--color-text-muted)] pl-6 mt-1">
                Период сравнения: {format(currentComparison.from, 'dd.MM.yyyy')} — {format(currentComparison.to, 'dd.MM.yyyy')}
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1 border-t border-[var(--color-border)]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Отмена
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="px-5 py-2 text-sm bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving ? 'Сохранение...' : willOverwrite ? 'Перезаписать' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}
