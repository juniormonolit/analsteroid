'use client';
import { useState, useRef } from 'react';
import { X, Search, GripVertical, Settings2 } from 'lucide-react';
import type { Metric } from '@/lib/metrics/types';
import type { MetricHighlightConfig } from '@/lib/saved-reports/types';
import { DEAL_FIELDS, DEFAULT_DEAL_FIELDS } from '@/lib/reports/dealFields';

const CATEGORY_ORDER = ['Сделки', 'Брони', 'Продажи', 'Отгрузки', 'Конверсии', 'Отказы', 'Планы', 'Прочее'];

// Ширина панели: максимум места, но так, чтобы справа влезли настройки метрики (320px).
export function getMetricPanelWidth(): number {
  if (typeof window === 'undefined') return 960;
  return Math.max(720, Math.min(1040, window.innerWidth - 220 - 400));
}

// Нормализация текста для поиска метрик: нижний регистр + служебные разделители
// (стрелки любых видов →←↔, тире/дефис, слэши, скобки, кавычки, знаки препинания)
// заменяются на пробел, лишние пробелы схлопываются. Нужно, чтобы «CR Сделка → Бронь»
// находилось по запросу «сделка бронь» — стрелка между словами не должна мешать поиску.
const SEARCH_SEPARATOR_RE = /[←-⇿➔➠-➿‐-―_/,;:()«»"'.\-]+/g;
function normalizeSearchText(s: string): string {
  return s.toLowerCase().replace(SEARCH_SEPARATOR_RE, ' ').replace(/\s+/g, ' ').trim();
}
// Метрика подходит под запрос, если ВСЕ токены запроса встречаются в нормализованном
// названии (в любом порядке) — так «сделка бронь» и «бронь сделка» оба находят метрику.
function matchesSearchTokens(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const normalized = normalizeSearchText(text);
  return tokens.every(t => normalized.includes(t));
}

// Охват метрики по названию: (перв.) / (повт.) / без суффикса = все
type Scope = 'primary' | 'repeat' | 'total';
function scopeOf(m: Metric): Scope {
  if (m.nameRu.includes('(перв.)')) return 'primary';
  if (m.nameRu.includes('(повт.)')) return 'repeat';
  return 'total';
}
const SCOPE_LABELS: { key: Scope; label: string; title: string }[] = [
  { key: 'primary', label: 'Перв.', title: 'Только первичные' },
  { key: 'repeat',  label: 'Повт.', title: 'Только повторные' },
  { key: 'total',   label: 'Все',   title: 'Общие метрики (без разбивки на перв./повт.)' },
];

// ── Reusable two-column metric selector (catalogue + ordered selection) ─────
function MetricSelector({
  metrics, selectedIds, onSelectedIdsChange,
  withGroups = false, columnGroups = [], onColumnGroupsChange,
  highlights, onMetricConfigure,
}: {
  metrics: Metric[];
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  withGroups?: boolean;
  columnGroups?: { name: string; metricIds: string[] }[];
  onColumnGroupsChange?: (g: { name: string; metricIds: string[] }[]) => void;
  highlights?: Record<string, MetricHighlightConfig>;
  onMetricConfigure?: (metricId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState<Scope | null>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dragItem = useRef<number | null>(null);
  const catRefs = useRef(new Map<string, HTMLDivElement>());

  const selectedSet = new Set(selectedIds);
  const selectedMetrics = selectedIds.map(id => metrics.find(m => m.id === id)).filter(Boolean) as Metric[];

  const searchTokens = normalizeSearchText(search).split(' ').filter(Boolean);
  const filtered = metrics.filter(m =>
    (searchTokens.length === 0 ||
      matchesSearchTokens(m.nameRu, searchTokens) ||
      matchesSearchTokens(m.nameShortRu ?? '', searchTokens) ||
      matchesSearchTokens(m.category ?? '', searchTokens))
    && (!scopeFilter || scopeOf(m) === scopeFilter)
  );
  const grouped = new Map<string, Metric[]>();
  for (const m of filtered) {
    const cat = m.category ?? 'Прочие';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(m);
  }
  const sortedCategories = [...grouped.keys()].sort((a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99));

  function toggleMetric(id: string) {
    if (selectedSet.has(id)) {
      if (selectedSet.size > 1) onSelectedIdsChange(selectedIds.filter(x => x !== id));
    } else onSelectedIdsChange([...selectedIds, id]);
  }

  const groupOf = new Map<string, string>();
  for (const g of columnGroups) for (const id of g.metricIds) groupOf.set(id, g.name);
  function addGroup() {
    let n = columnGroups.length + 1; let name = `Группа ${n}`;
    const names = new Set(columnGroups.map(g => g.name));
    while (names.has(name)) { n++; name = `Группа ${n}`; }
    onColumnGroupsChange?.([...columnGroups, { name, metricIds: [] }]);
  }
  function renameGroup(idx: number, newName: string) { onColumnGroupsChange?.(columnGroups.map((g, i) => i === idx ? { ...g, name: newName } : g)); }
  function deleteGroup(idx: number) { onColumnGroupsChange?.(columnGroups.filter((_, i) => i !== idx)); }
  function assignMetric(metricId: string, groupName: string | null) {
    let next = columnGroups.map(g => ({ ...g, metricIds: g.metricIds.filter(id => id !== metricId) }));
    if (groupName) next = next.map(g => g.name === groupName ? { ...g, metricIds: [...g.metricIds, metricId] } : g);
    onColumnGroupsChange?.(next);
  }

  function handleDrop(idx: number) {
    if (dragItem.current === null || dragItem.current === idx) return;
    const next = [...selectedIds];
    const [moved] = next.splice(dragItem.current, 1);
    next.splice(idx, 0, moved);
    onSelectedIdsChange(next);
    dragItem.current = null; setDraggingIdx(null); setDragOverIdx(null);
  }

  return (
    // Телефон: каталог и «Выбрано» друг под другом (50/50), md+: две колонки
    <div className="flex flex-col md:flex-row flex-1 min-h-0">
      <div className="flex flex-col flex-1 md:flex-none min-h-0 w-full md:w-[360px] shrink-0 border-b md:border-b-0 md:border-r border-[var(--color-border)]">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
          <Search size={14} className="text-[var(--color-text-muted)] shrink-0" />
          <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по названию или категории"
            className="flex-1 text-sm bg-transparent outline-none text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]" />
          {search && (
            <button onClick={() => setSearch('')} className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><X size={13} /></button>
          )}
        </div>

        {/* Фильтр охвата: перв./повт./общие. Повторный клик снимает фильтр. */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-[var(--color-border)]">
          <span className="text-[11px] text-[var(--color-text-muted)] uppercase tracking-wider mr-0.5">Вид</span>
          {SCOPE_LABELS.map(s => (
            <button
              key={s.key}
              title={s.title}
              onClick={() => setScopeFilter(prev => prev === s.key ? null : s.key)}
              className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${scopeFilter === s.key
                ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
            >
              {s.label}
            </button>
          ))}
          {scopeFilter && (
            <button onClick={() => setScopeFilter(null)} className="text-xs text-[var(--color-accent)] hover:underline ml-auto">сброс</button>
          )}
        </div>

        {/* Быстрые переходы к разделам */}
        <div className="flex flex-wrap gap-1 px-4 py-2 border-b border-[var(--color-border)]">
          {sortedCategories.map(cat => (
            <button
              key={cat}
              onClick={() => catRefs.current.get(cat)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="px-2 py-0.5 text-[11px] rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-sm text-[var(--color-text-muted)] text-center">Ничего не найдено</div>
          )}
          {sortedCategories.map(cat => (
            <div key={cat} ref={el => { if (el) catRefs.current.set(cat, el); else catRefs.current.delete(cat); }}>
              <div className="px-4 py-1 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider sticky top-0 bg-[var(--color-bg-surface)] z-10">
                {cat} <span className="normal-case font-normal opacity-60">· {grouped.get(cat)!.length}</span>
              </div>
              {grouped.get(cat)!.map(m => (
                <label key={m.id} className="flex items-start gap-2.5 px-4 py-1.5 hover:bg-[var(--color-bg-hover)] cursor-pointer">
                  <input type="checkbox" checked={selectedSet.has(m.id)} onChange={() => toggleMetric(m.id)} className="mt-0.5 accent-[var(--color-accent)]" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[var(--color-text)] truncate" title={m.nameRu}>{m.nameRu}</div>
                    <div className="text-xs text-[var(--color-text-muted)]">{cat} · {m.dataType}</div>
                  </div>
                </label>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
          <div className="text-sm font-medium text-[var(--color-text)]">Выбрано</div>
          <div className="flex items-center gap-3">
            {selectedIds.length > 0 && (
              <button
                onClick={() => onSelectedIdsChange([])}
                className="text-xs text-[var(--color-negative)] hover:underline"
                title="Снять все выбранные метрики"
              >
                Очистить всё
              </button>
            )}
            <div className="text-xs text-[var(--color-text-muted)]">{selectedIds.length} из {metrics.length}</div>
          </div>
        </div>
        {withGroups && (
          <div className="px-3 py-2 border-b border-[var(--color-border)] flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mr-1">Группы</span>
            {columnGroups.map((g, idx) => (
              <span key={idx} className="inline-flex items-center gap-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-1.5 py-0.5">
                <input value={g.name} onChange={e => renameGroup(idx, e.target.value)} className="text-xs bg-transparent outline-none text-[var(--color-text)] w-[90px]" />
                <button onClick={() => deleteGroup(idx)} className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-negative)]"><X size={11} /></button>
              </span>
            ))}
            <button onClick={addGroup} className="text-xs px-2 py-0.5 rounded border border-dashed border-[var(--color-border)] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">+ группа</button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto py-1">
          {selectedMetrics.map((m, i) => (
            <div key={m.id} draggable
              onDragStart={() => { dragItem.current = i; setDraggingIdx(i); }}
              onDragOver={e => { e.preventDefault(); setDragOverIdx(i); }}
              onDrop={() => handleDrop(i)}
              onDragEnd={() => { setDraggingIdx(null); setDragOverIdx(null); dragItem.current = null; }}
              className={`flex items-center gap-2 px-3 py-2 hover:bg-[var(--color-bg-hover)] transition-colors ${draggingIdx === i ? 'opacity-40' : ''} ${dragOverIdx === i && draggingIdx !== i ? 'border-t-2 border-[var(--color-accent)]' : ''}`}>
              <GripVertical size={14} className="text-[var(--color-text-muted)] cursor-grab shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[var(--color-text)] truncate">{m.nameRu}</div>
                <div className="text-xs text-[var(--color-text-muted)] truncate">{m.category ?? 'Прочие'}</div>
              </div>
              {withGroups && (
                <select value={groupOf.get(m.id) ?? ''} onChange={e => assignMetric(m.id, e.target.value || null)} onClick={e => e.stopPropagation()} title="Группа колонки"
                  className="text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-1.5 py-1 text-[var(--color-text-muted)] max-w-[110px] outline-none focus:border-[var(--color-accent)]">
                  <option value="">— без группы</option>
                  {columnGroups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
                </select>
              )}
              {onMetricConfigure && (
                <button onClick={() => onMetricConfigure(m.id)} title="Настройки метрики"
                  className={`tap-target p-1 rounded transition-colors ${highlights?.[m.id] ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
                  <Settings2 size={14} />
                </button>
              )}
              <button onClick={() => toggleMetric(m.id)} className="tap-target p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-negative)] transition-colors"><X size={14} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface Props {
  metrics: Metric[];
  selectedIds: string[];
  highlights: Record<string, MetricHighlightConfig>;
  onSelectedIdsChange: (ids: string[]) => void;
  onHighlightsChange: (h: Record<string, MetricHighlightConfig>) => void;
  onGlobalHighlight: (metricId: string, config: MetricHighlightConfig | null) => void;
  onClose: () => void;
  onMetricConfigure?: (metricId: string) => void;
  columnGroups: { name: string; metricIds: string[] }[];
  onColumnGroupsChange: (g: { name: string; metricIds: string[] }[]) => void;
  // Drilldown config
  drilldownDuplicate?: boolean;
  onDrilldownDuplicateChange?: (b: boolean) => void;
  drilldownMetricIds?: string[];
  onDrilldownMetricIdsChange?: (ids: string[]) => void;
  dealFields?: string[];
  onDealFieldsChange?: (f: string[]) => void;
}

type Tab = 'main' | 'products' | 'deals';

export function MetricPanel(props: Props) {
  const {
    metrics, selectedIds, highlights, onSelectedIdsChange, onClose, onMetricConfigure,
    columnGroups, onColumnGroupsChange,
    drilldownDuplicate = true, onDrilldownDuplicateChange,
    drilldownMetricIds, onDrilldownMetricIdsChange,
    dealFields, onDealFieldsChange,
  } = props;
  const [tab, setTab] = useState<Tab>('main');
  const [fDragIdx, setFDragIdx] = useState<number | null>(null);
  const [fOverIdx, setFOverIdx] = useState<number | null>(null);
  const fDrag = useRef<number | null>(null);

  const ddIds = (drilldownMetricIds && drilldownMetricIds.length) ? drilldownMetricIds : selectedIds;
  const shownFields = dealFields ?? DEFAULT_DEAL_FIELDS;
  const hiddenFields = DEAL_FIELDS.filter(f => !shownFields.includes(f.key));
  const labelOf = (k: string) => DEAL_FIELDS.find(f => f.key === k)?.label ?? k;

  function dropField(idx: number) {
    if (fDrag.current === null || fDrag.current === idx) return;
    const next = [...shownFields];
    const [m] = next.splice(fDrag.current, 1);
    next.splice(idx, 0, m);
    onDealFieldsChange?.(next);
    fDrag.current = null; setFDragIdx(null); setFOverIdx(null);
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: 'main', label: 'Основной отчёт' },
    { id: 'products', label: 'Товары (дрилл-даун)' },
    { id: 'deals', label: 'Сделки (дрилл-даун)' },
  ];

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/30" onClick={onClose} />
      {/* Телефон: панель на весь экран; md+: слайд-панель правее сайдбара */}
      <div className="fixed inset-0 md:inset-y-0 md:right-auto md:left-[220px] z-40 flex shadow-2xl">
        <div
          className="flex flex-col bg-[var(--color-bg-surface)] border-r border-[var(--color-border)] w-full md:w-[var(--metric-panel-w)] max-w-full"
          style={{ '--metric-panel-w': `${getMetricPanelWidth()}px` } as React.CSSProperties}
        >
          {/* Tabs + close. Крестик — вне скролла табов, чтобы на телефоне не уезжал за экран */}
          <div className="flex items-center gap-1 px-3 py-2 border-b border-[var(--color-border)]">
            <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto">
              {TABS.map(t => (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={`px-3 py-1.5 text-sm rounded-lg transition-colors whitespace-nowrap shrink-0 ${tab === t.id ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                  {t.label}
                </button>
              ))}
            </div>
            <button onClick={onClose} className="tap-target shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors p-1"><X size={16} /></button>
          </div>

          {tab === 'main' && (
            <MetricSelector
              metrics={metrics} selectedIds={selectedIds} onSelectedIdsChange={onSelectedIdsChange}
              withGroups columnGroups={columnGroups} onColumnGroupsChange={onColumnGroupsChange}
              highlights={highlights} onMetricConfigure={onMetricConfigure}
            />
          )}

          {tab === 'products' && (
            <div className="flex flex-col flex-1 min-h-0">
              <label className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] cursor-pointer">
                <input type="checkbox" checked={drilldownDuplicate} onChange={e => onDrilldownDuplicateChange?.(e.target.checked)} className="accent-[var(--color-accent)] w-4 h-4" />
                <span className="text-sm text-[var(--color-text)]">Дублировать метрики основного отчёта</span>
              </label>
              {drilldownDuplicate ? (
                <div className="flex-1 flex items-center justify-center text-center px-8">
                  <p className="text-sm text-[var(--color-text-muted)]">В дрилл-дауне по товарным группам показываются те же метрики, что в основном отчёте. Снимите галку, чтобы задать независимый набор.</p>
                </div>
              ) : (
                <MetricSelector
                  metrics={metrics}
                  selectedIds={ddIds}
                  onSelectedIdsChange={ids => onDrilldownMetricIdsChange?.(ids)}
                />
              )}
            </div>
          )}

          {tab === 'deals' && (
            <div className="flex flex-col flex-1 min-h-0">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
                <span className="text-sm font-medium text-[var(--color-text)]">Поля сделки</span>
                <div className="flex gap-2 text-xs">
                  <button onClick={() => onDealFieldsChange?.(DEFAULT_DEAL_FIELDS)} className="text-[var(--color-accent)] hover:underline">Все</button>
                  <button onClick={() => onDealFieldsChange?.([])} className="text-[var(--color-text-muted)] hover:underline">Ничего</button>
                </div>
              </div>
              <div className="px-4 py-2 text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border)]">Колонки в списке сделок при разворачивании товарной группы. Тяните за ручку для порядка. Сортировка по колонке — кликом по её заголовку в самом списке. Номер (#) всегда первый.</div>
              <div className="flex-1 overflow-y-auto py-1">
                {shownFields.map((k, i) => (
                  <div key={k} draggable
                    onDragStart={() => { fDrag.current = i; setFDragIdx(i); }}
                    onDragOver={e => { e.preventDefault(); setFOverIdx(i); }}
                    onDrop={() => dropField(i)}
                    onDragEnd={() => { setFDragIdx(null); setFOverIdx(null); fDrag.current = null; }}
                    className={`flex items-center gap-2 px-3 py-2 hover:bg-[var(--color-bg-hover)] transition-colors ${fDragIdx === i ? 'opacity-40' : ''} ${fOverIdx === i && fDragIdx !== i ? 'border-t-2 border-[var(--color-accent)]' : ''}`}>
                    <GripVertical size={14} className="text-[var(--color-text-muted)] cursor-grab shrink-0" />
                    <span className="text-sm text-[var(--color-text)] flex-1">{labelOf(k)}</span>
                    <button onClick={() => onDealFieldsChange?.(shownFields.filter(x => x !== k))} className="tap-target p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-negative)] transition-colors"><X size={14} /></button>
                  </div>
                ))}
                {hiddenFields.length > 0 && (
                  <div className="mt-1 pt-2 border-t border-[var(--color-border)]">
                    <div className="px-4 py-1 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">Скрытые</div>
                    {hiddenFields.map(f => (
                      <div key={f.key} className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--color-bg-hover)]">
                        <span className="text-sm text-[var(--color-text-muted)] flex-1 pl-5">{f.label}</span>
                        <button onClick={() => onDealFieldsChange?.([...shownFields, f.key])} className="text-xs px-2 py-0.5 rounded border border-dashed border-[var(--color-border)] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">+ добавить</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
