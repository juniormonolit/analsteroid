'use client';

// Страница «Сотрудники» (задача 2654): реестр — имя, bitrix_id, отдел, дата начала
// (инлайн-редактирование → sa.employee_registry.manual_start_date), стаж «X лет Y мес»,
// раскрывающаяся история переименований логина (слот-модель: имя на логине меняется).
// hire_date из sa.employees на проде не заполняется (подтверждено: пусто у всех) —
// стаж живёт на ручной дате; пусто = честное «не заполнено», не нули.

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, History, Search } from 'lucide-react';
import { tenureLabel } from '@/features/employees/engine/tenure';

interface NameHistoryItem { name: string; validFrom: string; validTo: string | null }
interface Row {
  bitrixId: number; fullName: string; departmentName: string | null; branch: string | null;
  isActive: boolean; hireDate: string | null; manualStartDate: string | null;
  startDate: string | null; notes: string; updatedBy: string | null; updatedAt: string | null;
  nameHistory: NameHistoryItem[];
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function StartDateCell({ row, onSave }: { row: Row; onSave: (v: string | null) => Promise<string | null> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const commit = async (value: string) => {
    setSaving(true);
    const err = await onSave(value === '' ? null : value);
    setSaving(false);
    if (err) { setError(err); return; }
    setError(null);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="cursor-text rounded px-1.5 py-0.5 text-left hover:bg-[var(--color-bg-hover)]"
        title="Изменить дату начала работы"
        onClick={() => { setDraft(row.manualStartDate ?? row.startDate ?? ''); setError(null); setEditing(true); }}
      >
        {row.startDate
          ? <span>{fmtDate(row.startDate)}{row.manualStartDate ? '' : ' (из синка)'}</span>
          : <span className="text-[var(--color-text-muted)]">не заполнено</span>}
      </button>
    );
  }
  return (
    <span className="inline-flex flex-col gap-0.5">
      <input
        type="date"
        autoFocus
        value={draft}
        disabled={saving}
        max={new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { void commit(draft); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit(draft);
          if (e.key === 'Escape') { setEditing(false); setError(null); }
        }}
        aria-invalid={!!error}
        className={`rounded border px-1.5 py-0.5 text-sm bg-[var(--color-bg)] ${error ? 'border-red-500' : 'border-[var(--color-border)]'}`}
      />
      {error && <span className="text-xs text-red-500">{error}</span>}
    </span>
  );
}

export function EmployeesPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [openHistory, setOpenHistory] = useState<Set<number>>(new Set());

  const { data, isLoading, isError } = useQuery<{ rows: Row[] }>({
    queryKey: ['employees'],
    queryFn: async () => {
      const res = await fetch('/api/employees');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    return all.filter(r =>
      (showInactive || r.isActive) &&
      (!q || r.fullName.toLowerCase().includes(q) || String(r.bitrixId).includes(q) ||
        (r.departmentName ?? '').toLowerCase().includes(q)),
    );
  }, [data, search, showInactive]);

  const saveDate = async (bitrixId: number, value: string | null): Promise<string | null> => {
    const res = await fetch('/api/employees/registry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bitrixId, manualStartDate: value }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return body?.error ?? `Ошибка ${res.status}`;
    }
    await qc.invalidateQueries({ queryKey: ['employees'] });
    return null;
  };

  const toggleHistory = (id: number) => {
    setOpenHistory(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Сотрудники</h1>
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Имя, ID, отдел…"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] py-1 pl-7 pr-2 text-sm"
          />
        </div>
        <label className="flex items-center gap-1.5 text-sm text-[var(--color-text-muted)]">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          показывать неактивных
        </label>
        <span className="text-xs text-[var(--color-text-muted)]">{rows.length} чел.</span>
      </div>

      {isLoading && <div className="p-6 text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
      {isError && <div className="p-6 text-sm text-red-500">Не удалось загрузить список сотрудников</div>}

      {!isLoading && !isError && (
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] text-left text-xs uppercase text-[var(--color-text-muted)]">
                <th className="px-3 py-2 font-medium">Сотрудник</th>
                <th className="px-3 py-2 font-medium">Bitrix ID</th>
                <th className="px-3 py-2 font-medium">Отдел</th>
                <th className="px-3 py-2 font-medium">Дата начала</th>
                <th className="px-3 py-2 font-medium">Стаж</th>
                <th className="px-3 py-2 font-medium">История имён</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const renames = Math.max(0, r.nameHistory.length - 1);
                const open = openHistory.has(r.bitrixId);
                const tenure = tenureLabel(r.startDate);
                return (
                  <FragmentRow key={r.bitrixId}>
                    <tr className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-bg-hover)]">
                      <td className="px-3 py-1.5">
                        <span className={r.isActive ? '' : 'text-[var(--color-text-muted)] line-through'}>{r.fullName}</span>
                      </td>
                      <td className="px-3 py-1.5 tabular-nums">{r.bitrixId}</td>
                      <td className="px-3 py-1.5">
                        {r.departmentName ?? <span className="text-[var(--color-text-muted)]">—</span>}
                        {r.branch ? <span className="ml-1 text-xs text-[var(--color-text-muted)]">({r.branch})</span> : null}
                      </td>
                      <td className="px-3 py-1.5">
                        <StartDateCell row={r} onSave={(v) => saveDate(r.bitrixId, v)} />
                      </td>
                      <td className="px-3 py-1.5">
                        {tenure ?? <span className="text-[var(--color-text-muted)]">не заполнено</span>}
                      </td>
                      <td className="px-3 py-1.5">
                        {r.nameHistory.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => toggleHistory(r.bitrixId)}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-[var(--color-bg-hover)]"
                          >
                            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <History size={13} />
                            {renames > 0 ? `${renames} переим.` : 'без переименований'}
                          </button>
                        ) : (
                          <span className="text-xs text-[var(--color-text-muted)]">нет данных</span>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)]">
                        <td colSpan={6} className="px-6 py-2">
                          <div className="flex flex-col gap-1 text-xs">
                            {[...r.nameHistory].reverse().map((h, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <span className="tabular-nums text-[var(--color-text-muted)]">
                                  {fmtDate(h.validFrom)} — {h.validTo ? fmtDate(h.validTo) : 'сейчас'}
                                </span>
                                <span className={h.validTo ? 'text-[var(--color-text-muted)]' : 'font-medium'}>{h.name}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-[var(--color-text-muted)]">Никого не найдено</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// tbody не принимает <>…</> с key — маленький помощник, чтобы пары строк
// (строка + раскрытая история) жили под одним key.
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
