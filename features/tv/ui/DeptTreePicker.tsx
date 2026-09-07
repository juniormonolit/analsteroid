'use client';
// Дерево отделов продаж с чекбоксами (uuid), для редактора экрана. Источник —
// /api/catalog/org-structure (поддерево «Отдел продаж», узлы несут id=uuid и
// bitrixId). Отличие от DepartmentPicker отчётов: там выбор по bitrixId и в
// поповере; экрану нужны uuid (resolveManagersForDepartments) и встроенный в
// форму список — поэтому свой компактный компонент, без второго источника данных.
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

export interface OrgNode { id: string; bitrixId: string; name: string; children?: OrgNode[] }

export function useOrgTree() {
  return useQuery({
    queryKey: ['org-structure'],
    queryFn: () => fetch('/api/catalog/org-structure').then(r => r.json()) as Promise<{ tree: OrgNode[] }>,
    staleTime: 5 * 60 * 1000,
  });
}

export function flattenNames(tree: OrgNode[]): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (n: OrgNode) => { m.set(n.id, n.name); (n.children ?? []).forEach(walk); };
  tree.forEach(walk);
  return m;
}

function Node({ node, depth, selected, onToggle }: { node: OrgNode; depth: number; selected: Set<string>; onToggle: (id: string) => void }) {
  const [open, setOpen] = useState(depth < 1);
  const kids = node.children ?? [];
  const checked = selected.has(node.id);
  return (
    <div>
      <div className="flex items-center gap-1 min-h-9" style={{ paddingLeft: depth * 14 }}>
        {kids.length > 0 ? (
          <button type="button" onClick={() => setOpen(o => !o)} className="tap-target p-0.5 text-[var(--color-text-muted)]" aria-label={open ? 'Свернуть' : 'Развернуть'}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : <span className="w-[19px]" />}
        <label className="flex items-center gap-2 cursor-pointer min-w-0 flex-1">
          <input type="checkbox" checked={checked} onChange={() => onToggle(node.id)} className="accent-[var(--color-accent)] w-4 h-4 shrink-0" />
          <span className={`text-sm truncate ${checked ? 'font-medium text-[var(--color-text)]' : 'text-[var(--color-text)]'}`}>{node.name}</span>
        </label>
      </div>
      {open && kids.map(k => <Node key={k.id} node={k} depth={depth + 1} selected={selected} onToggle={onToggle} />)}
    </div>
  );
}

export function DeptTreePicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { data, isLoading } = useOrgTree();
  const selected = new Set(value);
  const toggle = (id: string) => {
    const next = new Set(value);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange([...next]);
  };
  if (isLoading) return <div className="text-sm text-[var(--color-text-muted)] py-2">Загружаем структуру…</div>;
  const tree = data?.tree ?? [];
  return (
    <div className="border border-[var(--color-border)] rounded-lg p-2 max-h-64 overflow-y-auto overflow-x-hidden bg-[var(--color-bg)]">
      {tree.length === 0 && <div className="text-sm text-[var(--color-text-muted)]">Структура отделов недоступна</div>}
      {tree.map(n => <Node key={n.id} node={n} depth={0} selected={selected} onToggle={toggle} />)}
    </div>
  );
}
