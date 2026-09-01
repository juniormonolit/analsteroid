'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Users, X, Check } from 'lucide-react';

// Пользовательские группы строк отчёта (задача 2653): панель бейджей + создание
// группы. Создание (правка Серёги 31.07 №2) — чекбоксами ПРЯМО В СТРОКАХ отчёта:
// клик «Создать группу» включает режим выбора (SalesReportPage.groupSelectMode),
// в строках ReportTable появляются чекбоксы, название вводится в инлайн-панели
// GroupSelectPanel над таблицей. Старый попап CreateGroupModal УДАЛЁН (решение:
// один флоу вместо двух расходящихся — поиск по кандидатам заменяет строка
// поиска самого отчёта, «занятые» участники видны в строках с задизейбленным
// чекбоксом и тултипом, а не прячутся, как раньше в модалке).
// Один участник — в одной группе: чекбокс занятого disabled + серверная защита 409.

export interface UserReportGroup {
  id: string;
  name: string;
  member_ids: string[];
  // Тумблер (правка владельца 31.08, миграция 190): false — группа хранится на
  // аккаунте, но к отчёту не применяется (бейдж серый, строки не сворачиваются).
  enabled: boolean;
}

// Кнопка «Создать группу» (правка Серёги 31.07): живёт в ряду тулбара
// («Настройки отчёта» / «Сравнение») через слот userGroupsSlot в ReportToolbar —
// тот же стиль/размер, что у соседних кнопок. Теперь это тумблер режима выбора:
// повторный клик (или «Отмена» в панели) выходит из режима.
export function CreateGroupButton({ active, onClick }: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded-lg transition-colors ${
        active
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
          : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'
      }`}
    >
      <Users size={12} /> Создать группу
    </button>
  );
}

// Инлайн-панель режима выбора: поле названия + счётчик отмеченных +
// «Сохранить»/«Отмена». Рендерится над таблицей (на месте бейджей групп),
// пока активен режим чекбоксов.
export function GroupSelectPanel({ dimensionKey, selectedIds, entityLabel, onCancel, onCreated }: {
  dimensionKey: string;
  selectedIds: string[];
  entityLabel: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim() || selectedIds.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/report-groups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dimensionKey, name: name.trim(), memberIds: selectedIds }),
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
    <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2 border-b border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5">
      <Users size={14} className="text-[var(--color-accent)] flex-shrink-0" />
      <span className="text-xs text-[var(--color-text)] hidden sm:inline">
        Отметьте {entityLabel} галочками в строках отчёта
      </span>
      <input
        value={name} onChange={e => setName(e.target.value)} placeholder="Название группы"
        maxLength={80} autoFocus
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}
        className="px-3 py-1 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] w-[200px]"
      />
      <span className="text-xs text-[var(--color-text-muted)]">Отмечено: {selectedIds.length}</span>
      <div className="flex items-center gap-1.5 ml-auto">
        {error && <span className="text-xs text-[var(--color-negative)]">{error}</span>}
        <button
          onClick={save} disabled={!name.trim() || selectedIds.length === 0 || saving}
          className="flex items-center gap-1 px-3 py-1 text-xs rounded-lg bg-[var(--color-accent)] text-[var(--color-text-inverse)] disabled:opacity-40 hover:opacity-90"
        >
          <Check size={12} /> Сохранить
        </button>
        <button onClick={onCancel} className="px-3 py-1 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
          Отмена
        </button>
      </div>
    </div>
  );
}

export function UserGroupsBar({ dimensionKey, groups }: {
  dimensionKey: string;
  groups: UserReportGroup[];
}) {
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

  // Клик по бейджу — вкл/выкл группы (крестик по-прежнему расформировывает).
  const toggle = useMutation({
    mutationFn: async (g: UserReportGroup) => {
      const res = await fetch('/api/report-groups', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: g.id, enabled: !g.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: invalidate,
  });

  // Кнопка создания живёт в тулбаре (см. CreateGroupButton) — пустой бар не рисуем.
  if (groups.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 sm:px-4 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)]">
      {groups.map(g => (
        <span key={g.id}
          className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border transition-colors ${
            g.enabled
              ? 'border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10 text-[var(--color-text)]'
              : 'border-[var(--color-border)] text-[var(--color-text-muted)] opacity-70'}`}>
          <button onClick={() => toggle.mutate(g)} disabled={toggle.isPending}
            title={g.enabled ? 'Выключить группу (останется на аккаунте)' : 'Включить группу'}
            className="inline-flex items-center gap-1 hover:opacity-80">
            <Users size={11} className={g.enabled ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'} />
            <span className={g.enabled ? '' : 'line-through decoration-[1.5px]'}>{g.name}</span>
            <span className="text-[var(--color-text-muted)]">{g.member_ids.length}</span>
          </button>
          <button onClick={() => del.mutate({ id: g.id })} aria-label={`Расформировать группу ${g.name}`}
            title="Расформировать (удалить навсегда)"
            className="text-[var(--color-text-muted)] hover:text-[var(--color-negative)]"><X size={11} /></button>
        </span>
      ))}
      {groups.length > 1 && (
        <button onClick={() => del.mutate({ all: true })} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-negative)] px-1">
          сбросить все
        </button>
      )}
    </div>
  );
}
