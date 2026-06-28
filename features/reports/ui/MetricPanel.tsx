'use client';
import { useState, useRef } from 'react';
import { X, Search, GripVertical, Settings2 } from 'lucide-react';
import type { Metric } from '@/lib/metrics/types';
import type { MetricHighlightConfig } from '@/lib/saved-reports/types';

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
}

const CATEGORY_ORDER = ['Входящие', 'Брони', 'Продажи', 'Отгрузки', 'Конверсии', 'Суммы', 'Планы', 'Средние', 'Прочие'];

export function MetricPanel({
  metrics, selectedIds, highlights,
  onSelectedIdsChange, onHighlightsChange, onGlobalHighlight, onClose, onMetricConfigure,
  columnGroups, onColumnGroupsChange,
}: Props) {
  const [search, setSearch] = useState('');
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dragItem = useRef<number | null>(null);

  const selectedSet = new Set(selectedIds);
  const selectedMetrics = selectedIds
    .map(id => metrics.find(m => m.id === id))
    .filter(Boolean) as Metric[];

  const filtered = metrics.filter(m =>
    !search ||
    m.nameRu.toLowerCase().includes(search.toLowerCase()) ||
    (m.nameShortRu ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (m.category ?? '').toLowerCase().includes(search.toLowerCase())
  );

  // Group by category
  const grouped = new Map<string, Metric[]>();
  for (const m of filtered) {
    const cat = m.category ?? 'Прочие';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(m);
  }
  const sortedCategories = [...grouped.keys()].sort(
    (a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99)
  );

  function toggleMetric(id: string) {
    if (selectedSet.has(id)) {
      if (selectedSet.size > 1) onSelectedIdsChange(selectedIds.filter(x => x !== id));
    } else {
      onSelectedIdsChange([...selectedIds, id]);
    }
  }

  // ── Column groups ──
  const groupOf = new Map<string, string>();
  for (const g of columnGroups) for (const id of g.metricIds) groupOf.set(id, g.name);

  function addGroup() {
    let n = columnGroups.length + 1;
    let name = `Группа ${n}`;
    const names = new Set(columnGroups.map(g => g.name));
    while (names.has(name)) { n++; name = `Группа ${n}`; }
    onColumnGroupsChange([...columnGroups, { name, metricIds: [] }]);
  }
  function renameGroup(idx: number, newName: string) {
    onColumnGroupsChange(columnGroups.map((g, i) => i === idx ? { ...g, name: newName } : g));
  }
  function deleteGroup(idx: number) {
    onColumnGroupsChange(columnGroups.filter((_, i) => i !== idx));
  }
  function assignMetric(metricId: string, groupName: string | null) {
    let next = columnGroups.map(g => ({ ...g, metricIds: g.metricIds.filter(id => id !== metricId) }));
    if (groupName) next = next.map(g => g.name === groupName ? { ...g, metricIds: [...g.metricIds, metricId] } : g);
    onColumnGroupsChange(next);
  }

  // Drag-to-reorder selected list
  function handleDragStart(idx: number) {
    dragItem.current = idx;
    setDraggingIdx(idx);
  }
  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    setDragOverIdx(idx);
  }
  function handleDrop(idx: number) {
    if (dragItem.current === null || dragItem.current === idx) return;
    const next = [...selectedIds];
    const [moved] = next.splice(dragItem.current, 1);
    next.splice(idx, 0, moved);
    onSelectedIdsChange(next);
    dragItem.current = null;
    setDraggingIdx(null);
    setDragOverIdx(null);
  }
  function handleDragEnd() {
    setDraggingIdx(null);
    setDragOverIdx(null);
    dragItem.current = null;
  }

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 z-30 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="fixed left-0 top-0 bottom-0 z-40 flex shadow-2xl" style={{ left: 220 }}>
        <div className="flex bg-[var(--color-bg-surface)] border-r border-[var(--color-border)]" style={{ width: 680 }}>

          {/* Left: metric catalogue */}
          <div className="flex flex-col w-72 border-r border-[var(--color-border)]">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
              <Search size={14} className="text-[var(--color-text-muted)] shrink-0" />
              <input
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Поиск по названию или категории"
                className="flex-1 text-sm bg-transparent outline-none text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
              />
            </div>
            <div className="flex-1 overflow-y-auto py-2">
              {sortedCategories.map(cat => (
                <div key={cat}>
                  <div className="px-4 py-1 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider sticky top-0 bg-[var(--color-bg-surface)]">
                    {cat}
                  </div>
                  {grouped.get(cat)!.map(m => (
                    <label
                      key={m.id}
                      className="flex items-start gap-2.5 px-4 py-1.5 hover:bg-[var(--color-bg-hover)] cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedSet.has(m.id)}
                        onChange={() => toggleMetric(m.id)}
                        className="mt-0.5 accent-[var(--color-accent)]"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-[var(--color-text)] truncate">{m.nameRu}</div>
                        <div className="text-xs text-[var(--color-text-muted)]">{cat} · {m.dataType}</div>
                      </div>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Right: selected + order */}
          <div className="flex flex-col flex-1 min-w-0">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
              <div className="text-sm font-medium text-[var(--color-text)]">Выбрано</div>
              <div className="text-xs text-[var(--color-text-muted)]">{selectedIds.length} из {metrics.length} доступных</div>
              <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors ml-2">
                <X size={16} />
              </button>
            </div>

            {/* Groups manager */}
            <div className="px-3 py-2 border-b border-[var(--color-border)] flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mr-1">Группы</span>
              {columnGroups.map((g, idx) => (
                <span key={idx} className="inline-flex items-center gap-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-1.5 py-0.5">
                  <input
                    value={g.name}
                    onChange={e => renameGroup(idx, e.target.value)}
                    className="text-xs bg-transparent outline-none text-[var(--color-text)] w-[90px]"
                  />
                  <button onClick={() => deleteGroup(idx)} className="text-[var(--color-text-muted)] hover:text-[var(--color-negative)]">
                    <X size={11} />
                  </button>
                </span>
              ))}
              <button
                onClick={addGroup}
                className="text-xs px-2 py-0.5 rounded border border-dashed border-[var(--color-border)] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]"
              >
                + группа
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-1">
              {selectedMetrics.map((m, i) => {
                const hasHighlight = !!highlights[m.id];
                return (
                  <div
                    key={m.id}
                    draggable
                    onDragStart={() => handleDragStart(i)}
                    onDragOver={e => handleDragOver(e, i)}
                    onDrop={() => handleDrop(i)}
                    onDragEnd={handleDragEnd}
                    className={`flex items-center gap-2 px-3 py-2 hover:bg-[var(--color-bg-hover)] transition-colors ${
                      draggingIdx === i ? 'opacity-40' : ''
                    } ${dragOverIdx === i && draggingIdx !== i ? 'border-t-2 border-[var(--color-accent)]' : ''}`}
                  >
                    <GripVertical size={14} className="text-[var(--color-text-muted)] cursor-grab shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-[var(--color-text)] truncate">{m.nameRu}</div>
                      <div className="text-xs text-[var(--color-text-muted)] truncate">{m.category ?? 'Прочие'}</div>
                    </div>
                    <select
                      value={groupOf.get(m.id) ?? ''}
                      onChange={e => assignMetric(m.id, e.target.value || null)}
                      onClick={e => e.stopPropagation()}
                      title="Группа колонки"
                      className="text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-1.5 py-1 text-[var(--color-text-muted)] max-w-[110px] outline-none focus:border-[var(--color-accent)]"
                    >
                      <option value="">— без группы</option>
                      {columnGroups.map(g => (
                        <option key={g.name} value={g.name}>{g.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => onMetricConfigure?.(m.id)}
                      title="Настройки метрики"
                      className={`p-1 rounded transition-colors ${
                        hasHighlight
                          ? 'text-[var(--color-accent)]'
                          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                      }`}
                    >
                      <Settings2 size={14} />
                    </button>
                    <button
                      onClick={() => toggleMetric(m.id)}
                      className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-negative)] transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

    </>
  );
}
