'use client';
// Дерево узлов экрана с чекбоксами, для редактора экрана. Источник — /api/tv/tree
// (Монолит → филиалы → отделы Битрикса → команды; СПб — виртуальный узел branch:spb).
// Отличие от DepartmentPicker отчётов: там выбор по bitrixId и в поповере; здесь —
// встроенный в форму список и свои id узлов.
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

export interface OrgNode { id: string; name: string; kind?: 'root' | 'branch' | 'dept'; children?: OrgNode[] }

// Дерево экранов (features/tv/engine/orgTree.ts): Монолит → Москва / Санкт-Петербург /
// Краснодар → отделы → команды. Выбор родителя = все менеджеры поддерева + экран
// карточек подчинённых узлов.
export function useOrgTree() {
  return useQuery({
    queryKey: ['tv-tree'],
    queryFn: () => fetch('/api/tv/tree').then(r => r.json()) as Promise<{ tree: OrgNode[] }>,
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
  const [open, setOpen] = useState(depth < 2);
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
          <span className={`text-sm truncate ${checked ? 'font-medium' : ''} ${node.kind === 'root' || node.kind === 'branch' ? 'font-semibold' : ''} text-[var(--color-text)]`}>{node.name}</span>
          {node.kind === 'root' && <span className="text-xs text-[var(--color-text-muted)] shrink-0">все филиалы каруселью</span>}
          {node.kind === 'branch' && <span className="text-xs text-[var(--color-text-muted)] shrink-0">филиал</span>}
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
