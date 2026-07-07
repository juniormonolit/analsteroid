'use client';
import { useState } from 'react';
import { Check, X, ChevronDown, ChevronRight } from 'lucide-react';

interface Employee {
  login: string;
  name: string;
  teamId: string | null;
  teamName: string | null;
}

interface PlanData {
  plan_shipments: number;
  plan_n: number;
}

interface Props {
  employees: Employee[];
  months: string[]; // 'YYYY-MM' sorted
  plans: Map<string, Map<string, PlanData>>;
  grouping: 'none' | 'team';
  search: string;
  currentPlanN: number;
  onSaveCell: (login: string, month: string, plan_shipments: number, plan_n: number) => void;
}

function fmt(n: number) {
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

function EditableCell({
  value,
  planN,
  onSave,
}: {
  value: number | undefined;
  planN: number;
  onSave: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  function startEdit() {
    setDraft(value !== undefined ? String(value) : '');
    setEditing(true);
  }

  function confirm() {
    const num = parseFloat(draft.replace(/\s/g, '').replace(',', '.'));
    if (!isNaN(num)) onSave(num);
    setEditing(false);
  }

  function cancel() {
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1 min-w-[120px]">
        <input
          type="number"
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') cancel(); }}
          className="w-24 px-1.5 py-0.5 text-xs border border-[var(--color-accent)] rounded bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none"
        />
        <button onClick={confirm} className="tap-target text-[var(--color-positive)] hover:opacity-80"><Check size={12} /></button>
        <button onClick={cancel} className="tap-target text-[var(--color-text-muted)] hover:opacity-80"><X size={12} /></button>
      </div>
    );
  }

  return (
    <div
      onClick={startEdit}
      className="flex items-center justify-center cursor-pointer hover:text-[var(--color-accent)] transition-colors"
    >
      <span className="text-xs text-[var(--color-text)]">
        {value !== undefined ? fmt(value) : '—'}
      </span>
    </div>
  );
}

function SalesCell({ planData, currentPlanN }: { planData: PlanData | undefined; currentPlanN: number }) {
  if (!planData) return <span className="text-xs text-[var(--color-text-muted)]">—</span>;
  const n = planData.plan_n ?? currentPlanN;
  if (!n) return <span className="text-xs text-[var(--color-text-muted)]">—</span>;
  const sales = planData.plan_shipments / n;
  return <span className="text-xs text-[var(--color-text-muted)]">{fmt(sales)}</span>;
}

interface TeamGroup {
  teamId: string | null;
  teamName: string;
  members: Employee[];
}

export function PlansTable({ employees, months, plans, grouping, search, currentPlanN, onSaveCell }: Props) {
  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(new Set());

  const filtered = employees.filter(e => {
    if (!search) return true;
    const q = search.toLowerCase();
    return e.login.toLowerCase().includes(q) || e.name.toLowerCase().includes(q);
  });

  function toggleTeam(teamId: string) {
    setCollapsedTeams(prev => {
      const next = new Set(prev);
      if (next.has(teamId)) next.delete(teamId); else next.add(teamId);
      return next;
    });
  }

  const colWidth = 90;

  function renderEmployeeRow(emp: Employee) {
    const empPlans = plans.get(emp.login) ?? new Map<string, PlanData>();
    return (
      <tr key={emp.login} className="hover:bg-[var(--color-bg-hover)] border-b border-[var(--color-border)]">
        <td className="sticky left-0 bg-[var(--color-bg-surface)] z-10 px-3 py-2 w-80 min-w-[320px] max-md:w-[var(--report-dim-col)] max-md:min-w-[var(--report-dim-col)] max-md:max-w-[var(--report-dim-col)] border-r border-[var(--color-border)]">
          <div>
            <div className="text-sm text-[var(--color-text)] font-medium truncate">{emp.name}</div>
            <div className="text-xs text-[var(--color-text-muted)]">{emp.login}</div>
          </div>
        </td>
        {months.flatMap(m => {
          const planData = empPlans.get(m);
          return [
            <td key={`${m}-ship`} className="px-2 py-2 text-center border-r border-[var(--color-border)]" style={{ width: colWidth, minWidth: colWidth }}>
              <EditableCell
                value={planData?.plan_shipments}
                planN={currentPlanN}
                onSave={v => onSaveCell(emp.login, m, v, currentPlanN)}
              />
            </td>,
            <td key={`${m}-sales`} className="px-2 py-2 text-center border-r border-[var(--color-border)]" style={{ width: colWidth, minWidth: colWidth }}>
              <SalesCell planData={planData} currentPlanN={currentPlanN} />
            </td>,
          ];
        })}
      </tr>
    );
  }

  function renderGrouped() {
    const order: string[] = [];
    const groupMap = new Map<string, TeamGroup>();
    for (const emp of filtered) {
      const key = emp.teamId ?? '__no_team__';
      if (!groupMap.has(key)) {
        groupMap.set(key, { teamId: emp.teamId, teamName: emp.teamName ?? 'Без отдела', members: [] });
        order.push(key);
      }
      groupMap.get(key)!.members.push(emp);
    }

    return order.map(key => {
      const group = groupMap.get(key)!;
      const collapsed = collapsedTeams.has(key);
      return (
        <>
          <tr
            key={`group-${key}`}
            className="bg-[var(--color-bg-surface)] cursor-pointer"
            onClick={() => toggleTeam(key)}
          >
            <td
              colSpan={1 + months.length * 2}
              className="sticky left-0 px-3 py-1.5 border-b border-[var(--color-border)]"
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-accent)] uppercase tracking-wider">
                {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                {group.teamName}
                <span className="font-normal text-[var(--color-text-muted)] ml-1">({group.members.length})</span>
              </div>
            </td>
          </tr>
          {!collapsed && group.members.map(emp => renderEmployeeRow(emp))}
        </>
      );
    });
  }

  return (
    <div className="overflow-auto flex-1">
      <table className="border-collapse text-sm" style={{ minWidth: 320 + months.length * colWidth * 2 }}>
        <thead className="sticky top-0 z-20">
          <tr className="bg-[var(--color-bg-surface)] border-b border-[var(--color-border)]">
            <th className="sticky left-0 z-30 bg-[var(--color-bg-surface)] px-3 py-2 w-80 min-w-[320px] max-md:w-[var(--report-dim-col)] max-md:min-w-[var(--report-dim-col)] max-md:max-w-[var(--report-dim-col)] text-left text-xs font-semibold text-[var(--color-text-muted)] border-r border-[var(--color-border)] border-b border-[var(--color-border)]" rowSpan={2}>
              Менеджер
            </th>
            {months.map(m => (
              <th
                key={m}
                colSpan={2}
                className="px-2 py-1.5 text-center text-xs font-semibold text-[var(--color-text)] border-r border-[var(--color-border)] border-b border-[var(--color-border)]"
                style={{ minWidth: colWidth * 2 }}
              >
                {formatMonthLabel(m)}
              </th>
            ))}
          </tr>
          <tr className="bg-[var(--color-bg-surface)] border-b border-[var(--color-border)]">
            {months.flatMap(m => [
              <th key={`${m}-ship-h`} className="px-2 py-1 text-center text-xs text-[var(--color-text-muted)] font-normal border-r border-[var(--color-border)]" style={{ width: colWidth, minWidth: colWidth }}>Отгрузки</th>,
              <th key={`${m}-sales-h`} className="px-2 py-1 text-center text-xs text-[var(--color-text-muted)] font-normal border-r border-[var(--color-border)]" style={{ width: colWidth, minWidth: colWidth }}>Продажи</th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {grouping === 'team' ? renderGrouped() : filtered.map(emp => renderEmployeeRow(emp))}
        </tbody>
      </table>
    </div>
  );
}

function formatMonthLabel(ym: string) {
  const [year, month] = ym.split('-').map(Number);
  const shortYear = String(year).slice(2);
  const names = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
  return `${names[month - 1]} '${shortYear}`;
}
