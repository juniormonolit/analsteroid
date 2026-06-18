'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { Calendar, ChevronDown, Building2, X } from 'lucide-react';
import { applyPreset, PRESET_LABELS, type PresetKey, type DateRange } from '@/lib/period';

interface DeptNode {
  id: string;
  name: string;
  bitrixId: string;
  children?: DeptNode[];
}

interface Props {
  period: DateRange;
  comparison: DateRange;
  departmentIds: string[];
  onPeriodChange: (p: DateRange) => void;
  onComparisonChange: (p: DateRange) => void;
  onDepartmentIdsChange: (ids: string[]) => void;
}

const PRESETS: PresetKey[] = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month'];

function fmt(d: Date) {
  return format(d, 'd MMM yyyy', { locale: ru });
}

function DeptTree({
  nodes,
  selected,
  onToggle,
  depth = 0,
}: {
  nodes: DeptNode[];
  selected: Set<string>;
  onToggle: (bitrixId: string) => void;
  depth?: number;
}) {
  return (
    <>
      {nodes.map(node => (
        <div key={node.id}>
          <label
            className="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-bg-hover)] cursor-pointer text-sm"
            style={{ paddingLeft: `${12 + depth * 16}px` }}
          >
            <input
              type="checkbox"
              checked={selected.has(node.bitrixId)}
              onChange={() => onToggle(node.bitrixId)}
              className="accent-[var(--color-accent)]"
            />
            <span className="text-[var(--color-text)]">{node.name}</span>
          </label>
          {node.children && node.children.length > 0 && (
            <DeptTree nodes={node.children} selected={selected} onToggle={onToggle} depth={depth + 1} />
          )}
        </div>
      ))}
    </>
  );
}

export function FilterBar({ period, comparison, departmentIds, onPeriodChange, onComparisonChange, onDepartmentIdsChange }: Props) {
  const [showPresets, setShowPresets] = useState(false);
  const [showDepts, setShowDepts] = useState(false);

  const { data: orgData } = useQuery({
    queryKey: ['org-structure'],
    queryFn: () => fetch('/api/catalog/org-structure').then(r => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  const tree: DeptNode[] = orgData?.tree ?? [];
  const selectedSet = new Set(departmentIds);

  function toggleDept(bitrixId: string) {
    const next = new Set(selectedSet);
    if (next.has(bitrixId)) next.delete(bitrixId);
    else next.add(bitrixId);
    onDepartmentIdsChange(Array.from(next));
  }

  const deptLabel = departmentIds.length === 0
    ? 'Все отделы'
    : `${departmentIds.length} отд.`;

  return (
    <div className="flex items-center gap-3 px-6 py-2.5 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex-wrap">
      {/* Period preset picker */}
      <div className="relative">
        <button
          onClick={() => { setShowPresets(v => !v); setShowDepts(false); }}
          className="flex items-center gap-2 px-3 py-1.5 border border-[var(--color-border)] rounded-lg text-sm hover:border-[var(--color-border-focus)] transition-colors"
        >
          <Calendar size={14} className="text-[var(--color-text-muted)]" />
          <span>{fmt(period.from)} — {fmt(period.to)}</span>
          <ChevronDown size={14} className="text-[var(--color-text-muted)]" />
        </button>

        {showPresets && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowPresets(false)} />
            <div className="absolute top-full left-0 mt-1 z-20 bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-lg py-1 min-w-[180px]">
              {PRESETS.map(key => (
                <button
                  key={key}
                  onClick={() => { onPeriodChange(applyPreset(key)); setShowPresets(false); }}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-[var(--color-bg-hover)] transition-colors"
                >
                  {PRESET_LABELS[key]}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Comparison label */}
      <div className="text-sm text-[var(--color-text-muted)]">
        vs {fmt(comparison.from)} — {fmt(comparison.to)}
      </div>

      {/* Department filter */}
      <div className="relative ml-auto">
        <button
          onClick={() => { setShowDepts(v => !v); setShowPresets(false); }}
          className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-colors ${
            departmentIds.length > 0
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] hover:border-[var(--color-border-focus)]'
          }`}
        >
          <Building2 size={14} />
          <span>{deptLabel}</span>
          <ChevronDown size={14} className="text-[var(--color-text-muted)]" />
        </button>

        {showDepts && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowDepts(false)} />
            <div className="absolute top-full right-0 mt-1 z-20 bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-lg min-w-[240px] max-h-[320px] overflow-y-auto">
              {departmentIds.length > 0 && (
                <div className="px-3 py-2 border-b border-[var(--color-border)]">
                  <button
                    onClick={() => onDepartmentIdsChange([])}
                    className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-negative)] transition-colors"
                  >
                    <X size={12} />
                    Сбросить фильтр
                  </button>
                </div>
              )}
              <DeptTree nodes={tree} selected={selectedSet} onToggle={toggleDept} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
