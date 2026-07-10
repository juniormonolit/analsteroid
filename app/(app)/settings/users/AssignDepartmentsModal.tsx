'use client';
import { useState, useEffect, useMemo } from 'react';
import { Modal } from '@/components/ui/Modal';

// Раздел «Руководит» (Права v2): подконтрольные отделы пользователя (сводка в
// его ЛК; использование для карточек отдела РОПа — следующая итерация).
// Храним только явно отмеченные узлы; потомки отмеченного включаются неявно
// (в UI показываются заблокированной галкой). Назначает ТОЛЬКО супер-админ
// (см. app/api/admin/users/[id]/departments/route.ts).

interface DeptNode {
  id: string; // uuid departments.id — его и храним в user_departments
  bitrixId: string;
  name: string;
  children: DeptNode[];
}

interface Props {
  userId: string;
  userName: string;
  onClose: () => void;
  onSaved: () => void;
}

function TreeNode({
  node,
  depth,
  selected,
  inheritedOn,
  onToggle,
}: {
  node: DeptNode;
  depth: number;
  selected: Set<string>;
  inheritedOn: boolean;
  onToggle: (id: string) => void;
}) {
  const explicit = selected.has(node.id);
  const effectiveInherited = inheritedOn && !explicit;
  return (
    <>
      <label
        className={`flex items-center gap-2 py-1 cursor-pointer hover:bg-[var(--color-bg-hover)] rounded px-2 ${effectiveInherited ? 'opacity-60' : ''}`}
        style={{ paddingLeft: 8 + depth * 18 }}
        title={effectiveInherited ? 'Включён через родительский отдел' : undefined}
      >
        <input
          type="checkbox"
          checked={explicit || effectiveInherited}
          disabled={effectiveInherited}
          onChange={() => onToggle(node.id)}
          className="accent-[var(--color-accent)] w-4 h-4 shrink-0"
        />
        <span className="text-sm text-[var(--color-text)] truncate">{node.name}</span>
      </label>
      {node.children.map((c) => (
        <TreeNode
          key={c.id}
          node={c}
          depth={depth + 1}
          selected={selected}
          inheritedOn={inheritedOn || explicit}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}

export function AssignDepartmentsModal({ userId, userName, onClose, onSaved }: Props) {
  const [tree, setTree] = useState<DeptNode[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/catalog/org-structure').then((r) => r.json()),
      fetch(`/api/admin/users/${userId}/departments`).then((r) => r.json()),
    ])
      .then(([org, deps]: [{ tree?: DeptNode[] }, { departmentIds?: string[] }]) => {
        setTree(org.tree ?? []);
        setSelected(new Set(deps.departmentIds ?? []));
      })
      .catch(() => setError('Не удалось загрузить отделы'))
      .finally(() => setLoading(false));
  }, [userId]);

  const selectedCount = useMemo(() => selected.size, [selected]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/departments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ departmentIds: Array.from(selected) }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Не удалось сохранить');
      else onSaved();
    } catch {
      setError('Сетевая ошибка');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Руководит — ${userName}`}
      desktopWidth="sm:max-w-[440px]"
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-[var(--color-text-muted)]">
          Сводка по этим отделам показывается в ЛК пользователя. Дочерние отделы
          включаются автоматически.
        </p>

        <div className="border border-[var(--color-border)] rounded-lg overflow-y-auto max-h-[45dvh] py-1">
          {loading ? (
            <div className="px-3 py-4 text-sm text-[var(--color-text-muted)]">Загрузка...</div>
          ) : tree.length === 0 ? (
            <div className="px-3 py-4 text-sm text-[var(--color-text-muted)]">Отделы не найдены</div>
          ) : (
            tree.map((node) => (
              <TreeNode key={node.id} node={node} depth={0} selected={selected} inheritedOn={false} onToggle={toggle} />
            ))
          )}
        </div>

        {error && <div className="text-sm text-red-500">{error}</div>}

        <div className="flex items-center justify-between gap-2 pt-1 border-t border-[var(--color-border)]">
          <span className="text-xs text-[var(--color-text-muted)]">Выбрано: {selectedCount}</span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              Отмена
            </button>
            <button
              onClick={handleSave}
              disabled={loading || saving}
              className="px-5 py-2 text-sm bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
