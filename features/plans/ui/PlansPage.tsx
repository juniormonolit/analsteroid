'use client';
import { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X, ChevronDown, ChevronRight } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { PlansTable } from './PlansTable';
import { ImportSlide } from './ImportSlide';
import { ExportSlide } from './ExportSlide';

interface DeptNode {
  id: string;
  name: string;
  bitrixId: string;
  children?: DeptNode[];
}

interface PlanRow {
  manager_login: string;
  month: string;
  plan_shipments: number;
  plan_n: number;
}

interface EmployeeRaw {
  short_login: string;
  full_name: string;
  department_bitrix_id: string | null;
  team_id: string | null;
  team_name: string | null;
}

interface Employee {
  login: string;
  name: string;
  teamId: string | null;
  teamName: string | null;
  deptBitrixId: string | null;
}

type CheckState = 'none' | 'some' | 'all';

function allIdsNode(node: DeptNode): string[] {
  return [node.bitrixId, ...(node.children ?? []).flatMap(allIdsNode)];
}

function getCheckState(node: DeptNode, selected: Set<string>): CheckState {
  const ids = allIdsNode(node);
  const count = ids.filter(id => selected.has(id)).length;
  if (count === 0) return 'none';
  if (count === ids.length) return 'all';
  return 'some';
}

function DeptCheckboxInline({ state, onChange }: { state: CheckState; onChange: () => void }) {
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

function DeptTreeNodeInline({
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

  function handleCheck() { onToggle(allIdsNode(node), state !== 'all'); }

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
        <DeptCheckboxInline state={state} onChange={handleCheck} />
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
            <DeptTreeNodeInline key={child.id} node={child} selected={selected} onToggle={onToggle} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function currentYear() {
  return new Date().getFullYear();
}

function buildMonthsList(plans: Map<string, Map<string, { plan_shipments: number; plan_n: number }>>) {
  const year = currentYear();
  const months = new Set<string>();
  for (let m = 1; m <= 12; m++) {
    months.add(`${year}-${String(m).padStart(2, '0')}`);
  }
  for (const empMap of plans.values()) {
    for (const month of empMap.keys()) {
      months.add(month);
    }
  }
  return Array.from(months).sort();
}

export function PlansPage({ canEdit }: { canEdit: boolean }) {
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [grouping, setGrouping] = useState<'none' | 'team'>('none');
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [editingN, setEditingN] = useState(false);
  const [draftN, setDraftN] = useState('');
  const [showDepts, setShowDepts] = useState(false);
  const [deptDraft, setDeptDraft] = useState<Set<string>>(new Set());
  const qc = useQueryClient();

  const { data: settingsData } = useQuery<{ plan_n: number }>({
    queryKey: ['plan-settings'],
    queryFn: () => fetch('/api/plans/settings').then(r => r.json()),
    staleTime: 60_000,
  });
  const planN = settingsData?.plan_n ?? 0.8;

  const { data: plansData = [] } = useQuery<PlanRow[]>({
    queryKey: ['plans'],
    // 401/ошибка возвращает объект — без guard дальше падает обработка массива
    queryFn: () => fetch('/api/plans').then(r => r.json()).then(d => (Array.isArray(d) ? d : [])),
    staleTime: 30_000,
  });

  const { data: orgData } = useQuery({
    queryKey: ['org-structure'],
    queryFn: () => fetch('/api/catalog/org-structure').then(r => r.json()),
    staleTime: 5 * 60_000,
  });
  const tree: DeptNode[] = orgData?.tree ?? [];

  const { data: employeesRaw = [] } = useQuery<EmployeeRaw[]>({
    queryKey: ['plan-employees'],
    queryFn: () => fetch('/api/plans/employees').then(r => r.json()).then(d => (Array.isArray(d) ? d : [])),
    staleTime: 5 * 60_000,
  });

  const employees: Employee[] = useMemo(
    () => employeesRaw.map(e => ({
      login: e.short_login,
      name: e.full_name,
      teamId: e.team_id,
      teamName: e.team_name,
      deptBitrixId: e.department_bitrix_id,
    })),
    [employeesRaw],
  );

  const filteredEmployees = useMemo(() => {
    if (departmentIds.length === 0) return employees;
    const set = new Set(departmentIds);
    return employees.filter(e => e.deptBitrixId && set.has(e.deptBitrixId));
  }, [employees, departmentIds]);

  const plansMap = useMemo(() => {
    const m = new Map<string, Map<string, { plan_shipments: number; plan_n: number }>>();
    for (const row of plansData) {
      if (!m.has(row.manager_login)) m.set(row.manager_login, new Map());
      m.get(row.manager_login)!.set(row.month, { plan_shipments: row.plan_shipments, plan_n: row.plan_n });
    }
    return m;
  }, [plansData]);

  const months = useMemo(() => buildMonthsList(plansMap), [plansMap]);

  async function handleSaveCell(login: string, month: string, plan_shipments: number, plan_n: number) {
    await fetch(`/api/plans/${encodeURIComponent(login)}/${month}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_shipments, plan_n }),
    });
    await qc.invalidateQueries({ queryKey: ['plans'] });
  }

  async function handleSaveN() {
    const n = parseFloat(draftN.replace(',', '.'));
    if (isNaN(n) || n <= 0) { setEditingN(false); return; }
    await fetch('/api/plans/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_n: n }),
    });
    await qc.invalidateQueries({ queryKey: ['plan-settings'] });
    setEditingN(false);
  }

  function openDepts() {
    setDeptDraft(new Set(departmentIds));
    setShowDepts(true);
  }
  function applyDepts() {
    setDepartmentIds(Array.from(deptDraft));
    setShowDepts(false);
  }
  function cancelDepts() { setShowDepts(false); }

  function toggleDeptIds(ids: string[], forceOn?: boolean) {
    setDeptDraft(prev => {
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 sm:px-6 py-2.5 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex-wrap">
        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Поиск менеджера..."
            className="pl-8 pr-7 py-1.5 text-sm border border-[var(--color-border)] rounded-lg bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)] transition-colors w-48"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* Dept filter */}
        <Popover
          open={showDepts}
          onOpenChange={(o) => { if (o) openDepts(); else setShowDepts(false); }}
          className="min-w-[260px] flex flex-col overflow-hidden"
          trigger={
            <button
              className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-colors ${
                departmentIds.length > 0
                  ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-border-focus)] text-[var(--color-text)]'
              }`}
            >
              {departmentIds.length === 0 ? 'Все отделы' : `${departmentIds.length} отд.`}
            </button>
          }
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] flex-shrink-0">
            <span className="text-sm font-medium text-[var(--color-text)]">Отделы</span>
            {deptDraft.size > 0 && (
              <button onClick={() => setDeptDraft(new Set())} className="text-xs text-[var(--color-accent)] hover:underline">Очистить</button>
            )}
          </div>
          <div className="overflow-y-auto flex-1 py-1 max-h-[300px]">
            {tree.map(node => (
              <DeptTreeNodeInline key={node.id} node={node} selected={deptDraft} onToggle={toggleDeptIds} depth={0} />
            ))}
          </div>
          <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-[var(--color-border)] flex-shrink-0">
            <button onClick={cancelDepts} className="px-3 py-1.5 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">Отмена</button>
            <button onClick={applyDepts} className="px-4 py-1.5 text-sm bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 transition-opacity">Применить</button>
          </div>
        </Popover>

        {/* Grouping */}
        <div className="flex items-center gap-0 border border-[var(--color-border)] rounded-lg overflow-hidden">
          {(['none', 'team'] as const).map(g => (
            <button
              key={g}
              onClick={() => setGrouping(g)}
              className={`px-3 py-1.5 text-xs transition-colors ${
                grouping === g
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
              }`}
            >
              {g === 'none' ? 'Без группировки' : 'По отделу'}
            </button>
          ))}
        </div>

        {/* Plan N editor */}
        <div className="flex items-center gap-2 ml-2">
          <span className="text-xs text-[var(--color-text-muted)]">Коэф. план продаж:</span>
          {!canEdit ? (
            <span className="text-xs font-medium text-[var(--color-text)]">N = {planN}</span>
          ) : editingN ? (
            <input
              autoFocus
              type="number"
              step="0.01"
              value={draftN}
              onChange={e => setDraftN(e.target.value)}
              onBlur={handleSaveN}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveN(); if (e.key === 'Escape') setEditingN(false); }}
              className="w-16 px-1.5 py-0.5 text-xs border border-[var(--color-accent)] rounded bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none"
            />
          ) : (
            <button
              onClick={() => { setDraftN(String(planN)); setEditingN(true); }}
              className="text-xs font-medium text-[var(--color-accent)] hover:underline"
            >
              N = {planN}
            </button>
          )}
        </div>

        {canEdit && (
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => { setShowExport(true); setShowImport(false); }}
              className="px-3 py-1.5 text-sm border border-[var(--color-border)] rounded-lg text-[var(--color-text)] hover:border-[var(--color-border-focus)] transition-colors"
            >
              Экспорт шаблона
            </button>
            <button
              onClick={() => { setShowImport(true); setShowExport(false); }}
              className="px-3 py-1.5 text-sm bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 transition-opacity"
            >
              Импортировать
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <PlansTable
        employees={filteredEmployees}
        months={months}
        plans={plansMap}
        grouping={grouping}
        search={search}
        currentPlanN={planN}
        canEdit={canEdit}
        onSaveCell={handleSaveCell}
      />

      {/* Slides */}
      {showImport && (
        <ImportSlide currentPlanN={planN} onClose={() => setShowImport(false)} />
      )}
      {showExport && (
        <ExportSlide onClose={() => setShowExport(false)} />
      )}
    </div>
  );
}
