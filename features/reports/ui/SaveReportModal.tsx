'use client';
import { useState, useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';
import type { SavedReportInput, RelativePeriod, ComparisonMode, PeriodMode, PeriodAnchor, PeriodUnit } from '@/lib/saved-reports/types';
import type { DealScope, ClientType, Grouping, ProductGroupMode, ComparisonDisplay, BorderMode } from '@/lib/metrics/types';
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
  heatmapInvertedIds?: string[];
  colorizeMetrics?: boolean;
  zebra?: boolean;
  borderMode?: BorderMode;
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
  // Префилл имени (п.8 правок 09.07/2): название текущего отчёта — стандартного
  // (заголовок страницы) либо открытого сохранённого (его имя). Редактируемо.
  initialName?: string;
  // Id отчёта, который СЕЙЧАС открыт (страница /sales/saved/[id]) — если задан и имя/
  // раздел не сталкиваются с ЧУЖИМ отчётом, повторное «Сохранить» тихо обновляет
  // именно эту запись (PUT по id), без диалога конфликта — обычный флоу «открыл,
  // поправил, сохранил». undefined/null — обычный (не открытый сохранённый) отчёт.
  currentReportId?: string | null;
  // Правка 10.07 (см. WORKLOG): перезапись/копия — явный выбор пользователя через
  // диалог конфликта имён, а не молчаливое поведение. targetId задан только для
  // mode='update' (id существующей строки, которую перезаписываем — может отличаться
  // от currentReportId, если конфликт нашёлся под другим отчётом).
  onSave: (
    input: SavedReportInput,
    opts: { mode: 'create' | 'update' | 'copy'; targetId?: string }
  ) => Promise<{ ok: boolean; error?: string; name?: string } | void>;
  onClose: () => void;
}

export function SaveReportModal({
  reportSlug, metricIds, dealScope, clientType, grouping, comparisonDisplay,
  metricDisplayModes, comparisonThreshold,
  productGroupMode, departmentIds, highlights,
  pinnedMetricIds, metricDecimalOverrides, metricThresholdOverrides,
  accentedMetricIds, barMetricIds, heatmapMetricIds, heatmapInvertedIds, colorizeMetrics, zebra, borderMode, themeAccent, numberAlign, accountType,
  drilldownDuplicate, drilldownMetricIds, dealFields, drilldownGrouped,
  sourceDimension, drilldownDimension,
  sortBy, sortDir, columnGroups,
  currentPeriod, currentComparison,
  initialName, currentReportId,
  onSave, onClose,
}: Props) {
  const [name, setName] = useState(initialName ?? '');
  const [periodMode, setPeriodMode] = useState<PeriodMode>('relative');
  const [anchor, setAnchor] = useState<PeriodAnchor>('current');
  const [unit, setUnit] = useState<PeriodUnit>('month');
  const [compMode, setCompMode] = useState<ComparisonMode>('previous_tail');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingReports, setExistingReports] = useState<{ id: string; name: string; userLogin?: string; isShared?: boolean; sharedSection?: string | null }[]>([]);
  // Логин текущего пользователя — нужен, чтобы отличить «мой личный отчёт с таким
  // именем» (конфликт) от «чужой личный отчёт с таким же именем» (не конфликт, я его
  // даже не вижу в частностях — просто совпадение имени в разных приватных списках).
  const [myLogin, setMyLogin] = useState<string | null>(null);
  // Право сохранять в общие разделы («Роп монитор» / «Смекалочная»)
  const [canShare, setCanShare] = useState(false);
  // Раздел сохранения (п.3б спеки): личное избранное (по умолчанию) либо один из
  // двух управляемых общих разделов — одна механика, разные названия.
  const [section, setSection] = useState<'personal' | 'rop_monitor' | 'smekalochnaya'>('personal');
  // Диалог конфликта имён (правка владельца 10.07 — «сохранение отчётов работает
  // хуево»): раньше при совпадении имени в ДРУГОМ скоупе (не там, где имя реально
  // занято — например уже открытый отчёт «Товары» из «Смекалочной» пересохраняли в
  // «Роп монитор») тихо создавалась вторая запись с тем же именем — выглядело как
  // «не перезаписывает, а плодит копии». Теперь конфликт (см. computeConflict) не
  // сохраняется молча ни в какую сторону — показываем диалог с явным выбором.
  // pendingInput — собранный input, ждёт решения пользователя (Перезаписать/Копия/Отмена).
  const [conflict, setConflict] = useState<{ id: string; sharedSection: string | null } | null>(null);
  const [pendingInput, setPendingInput] = useState<SavedReportInput | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);

  useEffect(() => {
    fetch('/api/saved-reports')
      .then(r => r.json())
      // 401/ошибка возвращает объект, не массив — без проверки падает existingReports.find
      .then((data: { id: string; name: string; userLogin?: string; isShared?: boolean; sharedSection?: string | null }[]) => setExistingReports(Array.isArray(data) ? data : []))
      .catch(() => {});
    fetch('/api/auth/session')
      .then(r => r.json())
      .then((d: { user?: { login?: string; isSuperadmin?: boolean; permissions?: string[] } }) => {
        setMyLogin(d.user?.login ?? null);
        setCanShare(!!d.user?.isSuperadmin || !!d.user?.permissions?.includes('action.shared_reports.manage'));
      })
      .catch(() => {});
  }, []);

  // Подсказка у поля имени: «уже существует, повторное сохранение может
  // потребовать выбора» — любое совпадение имени (не обязательно в целевом скоупе,
  // достаточно намекнуть) в общем списке видимых отчётов (свои + все витринные).
  const existing = existingReports.find(r => r.name === name.trim());
  const willOverwrite = !!existing;
  // При обнаружении существующего ВИТРИННОГО отчёта с таким именем раздел
  // подхватывается автоматически — просто удобство, не влияет на конфликт-логику.
  useEffect(() => {
    if (existing?.sharedSection === 'rop_monitor' || existing?.sharedSection === 'smekalochnaya') {
      setSection(existing.sharedSection);
    }
  }, [existing?.sharedSection]);

  const relativePeriod: RelativePeriod = { anchor, unit };
  const effectiveSection: 'personal' | 'rop_monitor' | 'smekalochnaya' = canShare && section !== 'personal' ? section : 'personal';

  // Ищет РЕАЛЬНЫЙ конфликт имени в целевом скоупе сохранения:
  // - personal → мой же личный отчёт с этим именем (владелец = я);
  // - rop_monitor/smekalochnaya → любой витринный отчёт с этим именем, В ЛЮБОМ ИЗ
  //   ДВУХ общих разделов (не только в целевом) — иначе «переезд» отчёта между
  //   «Роп монитор» и «Смекалочная» с тем же именем не находил бы старую запись и
  //   плодил копию (ровно баг из жалобы владельца, воспроизведён 10.07).
  // currentReportId (открытый сейчас отчёт) исключается — его же с самим собой не
  // считаем конфликтом, это обычный флоу «поправил и сохранил».
  function findConflict(trimmedName: string) {
    if (effectiveSection === 'personal') {
      return existingReports.find(
        r => r.id !== currentReportId && r.name === trimmedName && !r.isShared && r.userLogin === myLogin
      ) ?? null;
    }
    return existingReports.find(r => r.id !== currentReportId && r.name === trimmedName && r.isShared) ?? null;
  }

  function buildInput(trimmedName: string): SavedReportInput {
    return {
      reportSlug,
      name: trimmedName,
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
      heatmapInvertedIds,
      colorizeMetrics,
      zebra,
      borderMode,
      themeAccent,
      numberAlign,
      accountType,
      drilldownDuplicateMetrics: drilldownDuplicate,
      drilldownMetricIds,
      dealFields,
      drilldownGrouped,
      sourceDimension,
      drilldownDimension,
      isShared: effectiveSection !== 'personal',
      sharedSection: effectiveSection !== 'personal' ? effectiveSection : null,
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
  }

  async function handleSave() {
    if (!name.trim()) return;
    const trimmed = name.trim();
    const input = buildInput(trimmed);
    const conflictRow = findConflict(trimmed);
    if (conflictRow) {
      // Не сохраняем молча ни в overwrite, ни в copy — ждём явного выбора.
      setError(null);
      setPendingInput(input);
      setConflict({ id: conflictRow.id, sharedSection: conflictRow.sharedSection ?? null });
      return;
    }
    setSaving(true);
    setError(null);
    const result = currentReportId
      ? await onSave(input, { mode: 'update', targetId: currentReportId })
      : await onSave(input, { mode: 'create' });
    setSaving(false);
    // onSave может ничего не вернуть (старое поведение) — тогда считаем успехом,
    // как раньше. Если вернул {ok:false}, модалку не закрываем и показываем причину.
    if (result && result.ok === false) {
      setError(result.error ?? 'Не удалось сохранить отчёт');
    }
  }

  function sectionLabel(s: string | null): string {
    if (s === 'rop_monitor') return '«Роп монитор»';
    if (s === 'smekalochnaya') return '«Отчёты Стаса»';
    return 'в личных отчётах';
  }

  async function handleOverwrite() {
    if (!pendingInput || !conflict) return;
    setConflictBusy(true);
    setError(null);
    const result = await onSave(pendingInput, { mode: 'update', targetId: conflict.id });
    setConflictBusy(false);
    if (result && result.ok === false) {
      setError(result.error ?? 'Не удалось перезаписать отчёт');
      setConflict(null);
    }
  }

  async function handleSaveCopy() {
    if (!pendingInput) return;
    setConflictBusy(true);
    setError(null);
    const result = await onSave(pendingInput, { mode: 'copy' });
    setConflictBusy(false);
    if (result && result.ok === false) {
      setError(result.error ?? 'Не удалось сохранить копию');
      setConflict(null);
    }
  }

  function handleCancelConflict() {
    setConflict(null);
    setPendingInput(null);
  }

  // Диалог конфликта имён — заменяет форму целиком (тот же <Modal>, стилистика как
  // у UnsavedChangesDialog: нейтральная «Отмена» / вторичная «Сохранить копию» /
  // акцентная primary «Перезаписать»).
  if (conflict) {
    return (
      <Modal
        open
        onOpenChange={o => { if (!o) handleCancelConflict(); }}
        title="Отчёт с таким названием уже есть"
        desktopWidth="sm:max-w-sm"
      >
        <div className="text-sm text-[var(--color-text-muted)] mb-5">
          Отчёт «{pendingInput?.name}» уже сохранён {sectionLabel(conflict.sharedSection)}. Перезаписать его новой
          конфигурацией (обновится у всех, кто им пользуется) или сохранить как отдельную копию?
        </div>
        {error && (
          <div className="text-xs text-[var(--color-error,#dc2626)] mb-3">
            {error}
          </div>
        )}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            type="button"
            onClick={handleCancelConflict}
            disabled={conflictBusy}
            className="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSaveCopy}
            disabled={conflictBusy}
            className="px-4 py-2 text-sm font-medium border border-[var(--color-border)] rounded-lg text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50"
          >
            Сохранить копию
          </button>
          <button
            type="button"
            onClick={handleOverwrite}
            disabled={conflictBusy}
            className="px-5 py-2 text-sm font-semibold bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {conflictBusy ? 'Перезаписываем...' : 'Перезаписать'}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onOpenChange={o => { if (!o) onClose(); }}
      title="Сохранить отчёт"
      desktopWidth="sm:max-w-[460px]"
    >
      <div className="flex flex-col gap-5">
        {/* Name */}
        <div className="flex flex-col gap-1.5">
          <input
            autoFocus
            placeholder="Название отчёта"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            className="w-full border border-[var(--color-border)] rounded-lg px-3 py-2 text-base sm:text-sm bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            list="existing-reports-list"
          />
          <datalist id="existing-reports-list">
            {existingReports.map(r => <option key={r.id} value={r.name} />)}
          </datalist>
          {willOverwrite && (
            <div className="text-xs text-[var(--color-warning,#f59e0b)]">
              Отчёт с таким названием уже есть — при сохранении будет предложено перезаписать или сохранить копию
            </div>
          )}
          {error && (
            <div className="text-xs text-[var(--color-error,#dc2626)]">
              {error}
            </div>
          )}
          {canShare && (
            <div className="flex flex-col gap-1.5 mt-1">
              <span className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Куда сохранить</span>
              <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm w-fit">
                {([
                  { value: 'personal' as const, label: 'Личное' },
                  { value: 'rop_monitor' as const, label: 'Роп монитор' },
                  { value: 'smekalochnaya' as const, label: 'Отчёты Стаса' },
                ]).map(o => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setSection(o.value)}
                    className={`px-3 py-1.5 transition-colors whitespace-nowrap ${
                      section === o.value ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {section !== 'personal' && (
                <span className="text-xs text-[var(--color-text-muted)]">
                  Общий раздел — виден всем пользователям, перезаписывать может любой администратор
                </span>
              )}
            </div>
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
                    ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)] border-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                }`}
              >
                {m === 'relative' ? 'Относительный' : 'Фиксированный'}
              </button>
            ))}
          </div>

          {periodMode === 'relative' ? (
            <div className="flex flex-wrap gap-2">
              <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm">
                {ANCHOR_OPTIONS.map(o => (
                  <button
                    key={o.value}
                    onClick={() => setAnchor(o.value)}
                    className={`px-3 py-1.5 transition-colors ${
                      anchor === o.value ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
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
                      unit === o.value ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
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
            className="px-5 py-2 text-sm bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
