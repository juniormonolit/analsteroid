'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Users, X } from 'lucide-react';

// Пользовательские группы строк отчёта (задача 2653): панель бейджей + модалка
// создания. Директор отмечает галочками менеджеров (или товарные группы),
// называет группу — участники схлопываются в одну строку-агрегат (см.
// applyUserGroups в SalesReportPage.tsx). Один участник — в одной группе:
// уже сгруппированные в кандидатах не показываются (плюс серверная защита 409).

export interface UserReportGroup {
  id: string;
  name: string;
  member_ids: string[];
}

export interface GroupCandidate { id: string; name: string; subtitle?: string }

export function UserGroupsBar({ dimensionKey, groups, candidates, entityLabel }: {
  dimensionKey: string;
  groups: UserReportGroup[];
  candidates: GroupCandidate[];   // строки текущего отчёта, ещё не состоящие в группах
  entityLabel: string;            // «менеджеров» / «товарных групп» — для текстов модалки
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['report-groups', dimensionKey] });

  const del = useMutation({
    mutationFn: async (payload: { id?: string; all?: boolean }) => {
      const res = await fetch('/api/report-groups', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload.all ? { all: true, dimensionKey } : { id: payload.id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: invalidate,
  });

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 sm:px-4 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)]">
      <button
        onClick={() => setModalOpen(true)}
        className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <Users size={13} /> Создать группу
      </button>
      {groups.map(g => (
        <span key={g.id} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10 text-[var(--color-text)]">
          <Users size={11} className="text-[var(--color-accent)]" />
          {g.name}
          <span className="text-[var(--color-text-muted)]">{g.member_ids.length}</span>
          <button onClick={() => del.mutate({ id: g.id })} aria-label={`Расформировать группу ${g.name}`}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-negative)]"><X size={11} /></button>
        </span>
      ))}
      {groups.length > 1 && (
        <button onClick={() => del.mutate({ all: true })} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-negative)] px-1">
          сбросить все
        </button>
      )}
      {modalOpen && (
        <CreateGroupModal
          dimensionKey={dimensionKey}
          candidates={candidates}
          entityLabel={entityLabel}
          onClose={() => setModalOpen(false)}
          onCreated={() => { invalidate(); setModalOpen(false); }}
        />
      )}
    </div>
  );
}

function CreateGroupModal({ dimensionKey, candidates, entityLabel, onClose, onCreated }: {
  dimensionKey: string;
  candidates: GroupCandidate[];
  entityLabel: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(c => c.name.toLowerCase().includes(q) || (c.subtitle ?? '').toLowerCase().includes(q));
  }, [candidates, query]);

  async function save() {
    if (!name.trim() || checked.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/report-groups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dimensionKey, name: name.trim(), memberIds: [...checked] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-[440px] max-h-[80vh] flex flex-col rounded-xl bg-[var(--color-bg-surface)] border border-[var(--color-border)] shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="p-4 pb-2">
          <h3 className="font-semibold text-[var(--color-text)] mb-2">Новая группа</h3>
          <input
            value={name} onChange={e => setName(e.target.value)} placeholder="Название группы"
            maxLength={80} autoFocus
            className="w-full px-3 py-1.5 mb-2 text-sm rounded-lg border border-[var(--color-border)] bg-transparent text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          <input
            value={query} onChange={e => setQuery(e.target.value)} placeholder="Поиск…"
            className="w-full px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] bg-transparent text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-1 min-h-[120px]">
          {filtered.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)] py-3">Нет свободных {entityLabel} (уже в группах или отфильтрованы).</p>
          ) : filtered.map(c => (
            <label key={c.id} className="flex items-center gap-2 py-1 text-sm text-[var(--color-text)] cursor-pointer hover:bg-[var(--color-bg-hover)] rounded px-1">
              <input
                type="checkbox"
                checked={checked.has(c.id)}
                onChange={() => setChecked(prev => { const n = new Set(prev); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })}
              />
              <span className="truncate">{c.name}</span>
              {c.subtitle && <span className="text-[11px] text-[var(--color-text-muted)]">{c.subtitle}</span>}
            </label>
          ))}
        </div>
        <div className="p-4 pt-2 border-t border-[var(--color-border)]">
          {error && <p className="text-xs text-[var(--color-negative)] mb-2">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-[var(--color-text-muted)]">Отмечено: {checked.size}</span>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
              <button
                onClick={save} disabled={!name.trim() || checked.size === 0 || saving}
                className="px-3 py-1.5 text-sm rounded-lg bg-[var(--color-accent)] text-[var(--color-text-inverse)] disabled:opacity-40 hover:opacity-90"
              >
                Создать
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
