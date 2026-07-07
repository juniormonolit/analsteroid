'use client';
import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, ChevronDown, ChevronRight, Download } from 'lucide-react';

interface DeptNode {
  id: string;
  name: string;
  bitrixId: string;
  children?: DeptNode[];
}

interface Props {
  onClose: () => void;
}

function allIds(node: DeptNode): string[] {
  return [node.bitrixId, ...(node.children ?? []).flatMap(allIds)];
}

type CheckState = 'none' | 'some' | 'all';

function getCheckState(node: DeptNode, selected: Set<string>): CheckState {
  const ids = allIds(node);
  const count = ids.filter(id => selected.has(id)).length;
  if (count === 0) return 'none';
  if (count === ids.length) return 'all';
  return 'some';
}

function DeptCheckbox({ state, onChange }: { state: CheckState; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'all'}
      onChange={onChange}
      className="accent-[var(--color-accent)] w-3.5 h-3.5 flex-shrink-0 cursor-pointer"
    />
  );
}

function DeptTreeNode({
  node, selected, onToggle, depth = 0,
}: {
  node: DeptNode;
  selected: Set<string>;
  onToggle: (ids: string[], forceOn?: boolean) => void;
  depth?: number;
}) {
  const hasChildren = (node.children ?? []).length > 0;
  const [expanded, setExpanded] = useState(depth === 0);
  const state = getCheckState(node, selected);

  function handleCheck() { onToggle(allIds(node), state !== 'all'); }

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1.5 hover:bg-[var(--color-bg-hover)] cursor-pointer select-none"
        style={{ paddingLeft: `${8 + depth * 16}px`, paddingRight: '8px' }}
      >
        <button
          className="flex-shrink-0 text-[var(--color-text-muted)] w-4 h-4 flex items-center justify-center"
          onClick={e => { e.stopPropagation(); if (hasChildren) setExpanded(v => !v); }}
        >
          {hasChildren
            ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)
            : <span className="w-3" />
          }
        </button>
        <DeptCheckbox state={state} onChange={handleCheck} />
        <span
          className={`text-sm truncate flex-1 ${depth === 0 ? 'font-medium text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}
          onClick={handleCheck}
        >
          {node.name}
        </span>
      </div>
      {hasChildren && expanded && (
        <div>
          {node.children!.map(child => (
            <DeptTreeNode key={child.id} node={child} selected={selected} onToggle={onToggle} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ExportSlide({ onClose }: Props) {
  const [selectedDeptIds, setSelectedDeptIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const { data: orgData } = useQuery({
    queryKey: ['org-structure'],
    queryFn: () => fetch('/api/catalog/org-structure').then(r => r.json()),
    staleTime: 5 * 60 * 1000,
  });
  const tree: DeptNode[] = orgData?.tree ?? [];

  function toggleIds(ids: string[], forceOn?: boolean) {
    setSelectedDeptIds(prev => {
      const next = new Set(prev);
      if (forceOn === true) ids.forEach(id => next.add(id));
      else if (forceOn === false) ids.forEach(id => next.delete(id));
      else {
        const allSelected = ids.every(id => next.has(id));
        if (allSelected) ids.forEach(id => next.delete(id));
        else ids.forEach(id => next.add(id));
      }
      return next;
    });
  }

  async function handleDownload() {
    setLoading(true);
    try {
      const params = selectedDeptIds.size > 0 ? `?deptIds=${Array.from(selectedDeptIds).join(',')}` : '';
      const res = await fetch(`/api/plans/export${params}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'plans_template.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-80 max-w-[94vw] bg-[var(--color-bg-surface)] shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <h2 className="text-base font-semibold text-[var(--color-text)]">Экспорт шаблона</h2>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto py-1">
          <p className="px-4 py-2 text-xs text-[var(--color-text-muted)]">
            Выберите отделы (пусто = все сотрудники)
          </p>
          {tree.map(node => (
            <DeptTreeNode key={node.id} node={node} selected={selectedDeptIds} onToggle={toggleIds} depth={0} />
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--color-border)] p-4 flex gap-2">
          <button
            onClick={handleDownload}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 py-2 bg-[var(--color-accent)] text-white text-sm rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <Download size={14} />
            {loading ? 'Загрузка...' : 'Скачать xlsx'}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Закрыть
          </button>
        </div>
      </div>
    </>
  );
}
