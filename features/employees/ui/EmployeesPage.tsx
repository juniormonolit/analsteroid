'use client';

// Страница «Сотрудники» (задача 2654): реестр — имя, bitrix_id, отдел, дата начала
// (инлайн-редактирование → sa.employee_registry.manual_start_date), стаж «X лет Y мес»,
// раскрывающаяся история переименований логина (слот-модель: имя на логине меняется).
// hire_date из sa.employees на проде не заполняется (подтверждено: пусто у всех) —
// стаж живёт на ручной дате; пусто = честное «не заполнено», не нули.
//
// Задача 2771 (Серёга зашёл с телефона как админ, не увидел ЛК — «нужен список
// всех менеджеров и РОПов, чтобы зайти к ним»): добавлены роль (колонка + текст
// поиска), фильтр по отделу, сортировка кликом по заголовку (внутри групп —
// группировка по отделу решили не убирать, это уже был ценный UX) и переход
// «Открыть ЛК» — только для canOpenCabinet (admin/director+, флаг из API,
// section.employees сам по себе на переход в чужой ЛК прав не даёт).
// Читает: /manager/[id]?view=readonly — та же ManagerCardPage, что и обычный
// ЛК, но принудительно read-only (см. ManagerCardPage.tsx, banner+forceReadOnly).

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronDown, ChevronRight, History, Search, UserCog } from 'lucide-react';
import { tenureLabel } from '@/features/employees/engine/tenure';

interface NameHistoryItem { name: string; validFrom: string; validTo: string | null }
type OrgRole = 'director' | 'rop' | 'manager';
const ROLE_LABEL: Record<OrgRole, string> = { director: 'Директор', rop: 'РОП', manager: 'Менеджер' };
// Порядок в сортировке по роли — руководство сверху, а не по алфавиту.
const ROLE_ORDER: Record<OrgRole, number> = { director: 0, rop: 1, manager: 2 };

interface Row {
  bitrixId: number; fullName: string; departmentName: string | null; branch: string | null;
  isActive: boolean; hireDate: string | null; manualStartDate: string | null;
  startDate: string | null; notes: string; updatedBy: string | null; updatedAt: string | null;
  nameHistory: NameHistoryItem[]; orgRole: OrgRole;
}

type SortKey = 'name' | 'role' | 'startDate';
type SortState = { key: SortKey; dir: 'asc' | 'desc' } | null;

// Тот же приём кликабельного заголовка, что в SubscriptionsPage.tsx (задача
// 2765) — тройной цикл asc → desc → сброс, ▲/▼ индикатор.
function SortableTh({ label, sortKey, sort, onSort }: {
  label: string; sortKey: SortKey; sort: SortState; onSort: (k: SortKey) => void;
}) {
  const active = sort?.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      className="px-3 py-2 font-medium cursor-pointer select-none hover:text-[var(--color-text)]"
    >
      {label}<span className="inline-block w-3 text-[10px]">{active ? (sort!.dir === 'asc' ? '▲' : '▼') : ''}</span>
    </th>
  );
}

function sortRows(rows: Row[], sort: SortState): Row[] {
  if (!sort) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.key === 'role') return (ROLE_ORDER[a.orgRole] - ROLE_ORDER[b.orgRole]) * dir;
    if (sort.key === 'startDate') return (a.startDate ?? '').localeCompare(b.startDate ?? '') * dir;
    return a.fullName.localeCompare(b.fullName, 'ru') * dir;
  });
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
  const [deptFilter, setDeptFilter] = useState('');
  const [sort, setSort] = useState<SortState>(null);
  const [openHistory, setOpenHistory] = useState<Set<number>>(new Set());
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set());

  const { data, isLoading, isError } = useQuery<{ rows: Row[]; canOpenCabinet: boolean }>({
    queryKey: ['employees'],
    queryFn: async () => {
      const res = await fetch('/api/employees');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const canOpenCabinet = data?.canOpenCabinet ?? false;

  // Список отделов для фильтра — из самих строк (без отдельного запроса).
  const deptOptions = useMemo(() => {
    const set = new Set((data?.rows ?? []).map(r => r.departmentName).filter((x): x is string => !!x));
    return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
  }, [data]);

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    return all.filter(r =>
      (showInactive || r.isActive) &&
      (!deptFilter || r.departmentName === deptFilter) &&
      (!q || r.fullName.toLowerCase().includes(q) || String(r.bitrixId).includes(q) ||
        (r.departmentName ?? '').toLowerCase().includes(q) || ROLE_LABEL[r.orgRole].toLowerCase().includes(q)),
    );
  }, [data, search, showInactive, deptFilter]);

  const onSort = (key: SortKey) => {
    setSort(cur => {
      if (cur?.key !== key) return { key, dir: 'asc' };
      if (cur.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  };

  // Группировка по отделам (фидбек Серёги 31.07): заголовок-отдел, внутри сотрудники,
  // сворачивание как у деревьев. Поиск работает поверх группировки (пустые отделы
  // после фильтра исчезают). «Без отдела» — в конец. Сортировка (задача 2771) —
  // ВНУТРИ каждой группы, группировку не убирали — она сама по себе ценный UX
  // (фидбек 31.07), а не альтернатива сортировке.
  const groups = useMemo(() => {
    const by = new Map<string, Row[]>();
    for (const r of rows) {
      const key = r.departmentName ?? 'Без отдела';
      const list = by.get(key) ?? [];
      list.push(r);
      by.set(key, list);
    }
    return [...by.entries()]
      .sort((a, b) => a[0] === 'Без отдела' ? 1 : b[0] === 'Без отдела' ? -1 : a[0].localeCompare(b[0], 'ru'))
      .map(([name, list]) => [name, sortRows(list, sort)] as const);
  }, [rows, sort]);

  const toggleDept = (name: string) => {
    setCollapsedDepts(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

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
    // h-full overflow-y-auto — AppShell main стоит в overflow-hidden, без своего
    // скролл-контейнера страница не прокручивается (тот же фикс, что /charts, 0bdd06f).
    <div className="h-full overflow-y-auto overflow-x-hidden">
    <div className="p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Сотрудники</h1>
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Имя, ID, отдел, роль…"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] py-1 pl-7 pr-2 text-sm"
          />
        </div>
        <select
          value={deptFilter}
          onChange={(e) => setDeptFilter(e.target.value)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] py-1 px-2 text-sm text-[var(--color-text)]"
        >
          <option value="">Все отделы</option>
          {deptOptions.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
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
                <SortableTh label="Сотрудник" sortKey="name" sort={sort} onSort={onSort} />
                <th className="px-3 py-2 font-medium">Bitrix ID</th>
                <SortableTh label="Роль" sortKey="role" sort={sort} onSort={onSort} />
                <th className="px-3 py-2 font-medium">Отдел</th>
                <SortableTh label="Дата начала" sortKey="startDate" sort={sort} onSort={onSort} />
                <th className="px-3 py-2 font-medium">Стаж</th>
                <th className="px-3 py-2 font-medium">История имён</th>
                {canOpenCabinet && <th className="px-3 py-2 font-medium">ЛК</th>}
              </tr>
            </thead>
            <tbody>
              {groups.map(([deptName, deptRows]) => (
                <FragmentRow key={`dept:${deptName}`}>
                  <tr
                    className="cursor-pointer border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] hover:bg-[var(--color-bg-hover)]"
                    onClick={() => toggleDept(deptName)}
                  >
                    <td colSpan={canOpenCabinet ? 8 : 7} className="px-3 py-1.5 text-sm font-semibold">
                      <span className="inline-flex items-center gap-1.5">
                        {collapsedDepts.has(deptName) ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                        {deptName}
                        <span className="font-normal text-xs text-[var(--color-text-muted)]">{deptRows.length} чел.</span>
                        {deptRows[0]?.branch && deptName !== 'Без отдела' ? (
                          <span className="font-normal text-xs text-[var(--color-text-muted)]">· {deptRows[0].branch}</span>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                  {!collapsedDepts.has(deptName) && deptRows.map((r) => {
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
                        <span
                          className="inline-flex items-center rounded px-1.5 py-px text-[11px] font-semibold"
                          style={r.orgRole === 'manager'
                            ? { color: 'var(--color-text-muted)', backgroundColor: 'var(--color-bg-hover)' }
                            : { color: 'var(--color-accent)', backgroundColor: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' }}
                        >
                          {ROLE_LABEL[r.orgRole]}
                        </span>
                      </td>
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
                      {canOpenCabinet && (
                        <td className="px-3 py-1.5">
                          <Link
                            href={`/manager/${r.bitrixId}?view=readonly&name=${encodeURIComponent(r.fullName)}`}
                            className="tap-target inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs font-semibold text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] whitespace-nowrap"
                            title={`Открыть ЛК: ${r.fullName} (только чтение)`}
                          >
                            <UserCog size={13} /> Открыть ЛК
                          </Link>
                        </td>
                      )}
                    </tr>
                    {open && (
                      <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)]">
                        <td colSpan={canOpenCabinet ? 8 : 7} className="px-6 py-2">
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
                </FragmentRow>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={canOpenCabinet ? 8 : 7} className="px-3 py-6 text-center text-sm text-[var(--color-text-muted)]">Никого не найдено</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </div>
  );
}

// tbody не принимает <>…</> с key — маленький помощник, чтобы пары строк
// (строка + раскрытая история) жили под одним key.
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
