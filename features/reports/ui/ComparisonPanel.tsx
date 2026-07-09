'use client';
import { useMemo, useState } from 'react';
import { X, Plus, Search, Scale } from 'lucide-react';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SLIDE_BACKDROP_BG } from '@/components/ui/SlideBackdrop';
import { formatValue } from '@/lib/format';
import type { Metric } from '@/lib/metrics/types';

// Режим «Сравнение» (п. Н2 спеки analsteroid-edits-spec-agreed-20260708.md): «как
// сравнение товаров в интернет-магазине» — выбранные сущности текущего отчёта
// (менеджеры / товарные группы / источники, тип = тип текущего отчёта, не смешиваем)
// колонками, метрики текущего отчёта строками, лучшее значение в строке подсвечено.
//
// Данные — ЧИСТО КЛИЕНТСКИЕ: `rows` — уже загруженный (нефильтрованный поиском и
// негруппированный) набор строк отчёта (SalesReportPage передаёт `data?.rows`), в
// котором для каждой сущности уже посчитан `current` по ВСЕМ зафетченным метрикам за
// текущий период с текущими фильтрами отчёта. Отдельного запроса нет.

export interface ComparisonRow {
  dimensionId: string;
  dimensionName: string;
  deltas: Record<string, { current: number | null }>;
}

interface Props {
  rows: ComparisonRow[];
  metrics: Metric[];
  entityLabel: string;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  metricDecimalOverrides?: Record<string, number>;
  onClose: () => void;
}

// Метрики «чем меньше — тем лучше» (отказы): направление подсветки лучшего значения
// в строке инвертируется. Для остальных метрик по умолчанию «больше = лучше» — как
// в п.4 спеки Н2 («направление больше=лучше по умолчанию, для отказов наоборот»).
function isLowerBetter(m: Metric): boolean {
  return m.category === 'Отказы' || /lost|отказ/i.test(m.id) || /отказ/i.test(m.nameRu);
}

export function ComparisonPanel({
  rows, metrics, entityLabel, selectedIds, onSelectedIdsChange, metricDecimalOverrides = {}, onClose,
}: Props) {
  const [query, setQuery] = useState('');
  const { closing, requestClose } = useSlideClose(onClose);

  const byId = useMemo(() => new Map(rows.map(r => [r.dimensionId, r])), [rows]);
  const selectedSet = new Set(selectedIds);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? rows.filter(r => r.dimensionName.toLowerCase().includes(q)) : rows;
  }, [rows, query]);

  function toggle(id: string) {
    if (selectedSet.has(id)) onSelectedIdsChange(selectedIds.filter(x => x !== id));
    else onSelectedIdsChange([...selectedIds, id]);
  }

  const selectedRows = selectedIds.map(id => byId.get(id)).filter(Boolean) as ComparisonRow[];

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Полоска-подложка для закрытия — как в дрилл-дауне (п. Н3, тот же язычок-таб).
          Цвет/прозрачность — общий эталон затемнения (SLIDE_BACKDROP_BG, правка 09.07). */}
      <div
        className={`hidden sm:block w-[10%] shrink-0 ${SLIDE_BACKDROP_BG} cursor-pointer transition-opacity duration-150 ${closing ? 'opacity-0' : 'opacity-100'}`}
        onClick={requestClose}
      />
      <PanelCloseTab onClick={requestClose} style={{ left: '10%', transform: 'translateX(-100%)' }} />
      <div className={`flex-1 min-w-0 bg-[var(--color-bg)] flex flex-col shadow-2xl overflow-hidden ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}>
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-3 sm:px-6 py-3 sm:py-4 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-[var(--color-text)] text-base flex items-center gap-2">
              <Scale size={16} className="text-[var(--color-accent)] shrink-0" />
              Сравнение
            </h2>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {entityLabel} · {selectedIds.length ? `${selectedIds.length} в сравнении` : 'ничего не выбрано'}
            </p>
          </div>
          <button onClick={requestClose} className="sm:hidden p-2 hover:bg-[var(--color-bg-hover)] rounded-lg transition-colors shrink-0">
            <X size={18} />
          </button>
        </div>

        {/* Поиск + добавление сущностей */}
        <div className="px-3 sm:px-6 py-3 border-b border-[var(--color-border)] shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={`Поиск: ${entityLabel.toLowerCase()}...`}
              className="w-full pl-8 pr-7 py-1.5 text-sm border border-[var(--color-border)] rounded-lg bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)] transition-colors"
            />
            {query && (
              <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                <X size={13} />
              </button>
            )}
          </div>
          <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-sm text-[var(--color-text-muted)] text-center">Ничего не найдено</div>
            )}
            {filtered.map(r => {
              const active = selectedSet.has(r.dimensionId);
              return (
                <button
                  key={r.dimensionId}
                  onClick={() => toggle(r.dimensionId)}
                  title={active ? 'Убрать из сравнения' : 'Добавить к сравнению'}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-left hover:bg-[var(--color-bg-hover)] transition-colors ${active ? 'bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]' : ''}`}
                >
                  <span className="truncate text-[var(--color-text)]">{r.dimensionName}</span>
                  {active
                    ? <X size={14} className="text-[var(--color-negative)] shrink-0" />
                    : <Plus size={14} className="text-[var(--color-accent)] shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Таблица сравнения: сущности — колонки, метрики — строки */}
        <div className="flex-1 overflow-auto">
          {selectedRows.length === 0 ? (
            <div className="p-10 text-center text-sm text-[var(--color-text-muted)]">
              Добавьте {entityLabel.toLowerCase()} выше, чтобы сравнить метрики текущего отчёта
            </div>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-[var(--color-table-header)]">
                  <th className="sticky left-0 z-10 bg-[var(--color-table-header)] text-left px-3 py-2 text-xs font-medium text-[var(--color-text-muted)] whitespace-nowrap border-b border-r border-[var(--color-border)]">
                    Метрика
                  </th>
                  {selectedRows.map(r => (
                    <th key={r.dimensionId} className="px-3 py-2 text-xs font-medium text-[var(--color-text)] whitespace-nowrap border-b border-[var(--color-border)] min-w-[130px]">
                      <div className="flex items-center justify-center gap-1.5">
                        <span className="truncate max-w-[160px]" title={r.dimensionName}>{r.dimensionName}</span>
                        <button onClick={() => toggle(r.dimensionId)} title="Убрать из сравнения" className="text-[var(--color-text-muted)] hover:text-[var(--color-negative)] shrink-0">
                          <X size={12} />
                        </button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map((m, mi) => {
                  const lowerBetter = isLowerBetter(m);
                  const vals = selectedRows.map(r => r.deltas[m.id]?.current ?? null);
                  const nonNull = vals.filter((v): v is number => v !== null);
                  const best = selectedRows.length > 1 && nonNull.length > 1
                    ? (lowerBetter ? Math.min(...nonNull) : Math.max(...nonNull))
                    : null;
                  const dec = metricDecimalOverrides[m.id] ?? m.decimalPlaces;
                  const isStripe = mi % 2 === 1;
                  const stripeCls = isStripe ? 'bg-[var(--color-table-stripe)]' : 'bg-[var(--color-bg)]';
                  return (
                    <tr key={m.id} className={`border-t border-[var(--color-border)] ${stripeCls}`}>
                      <td className={`sticky left-0 z-10 px-3 py-2 whitespace-nowrap border-r border-[var(--color-border)] ${stripeCls}`}>
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: m.color ?? 'var(--color-text-muted)' }} />
                          {m.nameRu}
                        </span>
                      </td>
                      {vals.map((v, i) => {
                        const isBest = best !== null && v === best;
                        return (
                          <td key={selectedRows[i].dimensionId} className={`px-3 py-2 text-center tabular-nums whitespace-nowrap ${isBest ? 'font-semibold text-[var(--color-positive)]' : 'text-[var(--color-text)]'}`}>
                            <span className="inline-flex items-center gap-1">
                              {isBest && <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-positive)] shrink-0" />}
                              {formatValue(v, m.dataType, dec)}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
