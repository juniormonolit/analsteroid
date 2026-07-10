'use client';
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { PERM_SECTIONS, PERM_ACTIONS } from '@/lib/auth/perms';
import type { Role } from './page';

interface Props {
  role: Role | null; // null = создание новой
  onClose: () => void;
  onSaved: () => void;
}

function PermGroup({
  title,
  items,
  selected,
  onToggle,
}: {
  title: string;
  items: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  selected: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">{title}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {items.map((p) => (
          <label key={p.key} className="flex items-center gap-2 cursor-pointer py-0.5">
            <input
              type="checkbox"
              checked={selected.has(p.key)}
              onChange={() => onToggle(p.key)}
              className="accent-[var(--color-accent)] w-4 h-4 shrink-0"
            />
            <span className="text-sm text-[var(--color-text)]">{p.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function RoleEditorModal({ role, onClose, onSaved }: Props) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        permissions: Array.from(selected),
      };
      const res = await fetch(role ? `/api/admin/roles/${role.id}` : '/api/admin/roles', {
        method: role ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Не удалось сохранить роль');
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
      title={role ? `Роль «${role.name}»` : 'Новая роль'}
      desktopWidth="sm:max-w-[520px]"
    >
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
              Название
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={role?.isSystem}
              placeholder="Например: Руководитель отдела"
              className="w-full border border-[var(--color-border)] rounded-lg px-3 py-2 text-base sm:text-sm bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-60"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
              Описание
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Необязательно"
              className="w-full border border-[var(--color-border)] rounded-lg px-3 py-2 text-base sm:text-sm bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
          </div>
        </div>

        <PermGroup title="Видимость разделов" items={PERM_SECTIONS} selected={selected} onToggle={toggle} />
        <PermGroup title="Действия" items={PERM_ACTIONS} selected={selected} onToggle={toggle} />

        {error && <div className="text-sm text-red-500">{error}</div>}

        <div className="flex justify-end gap-2 pt-1 border-t border-[var(--color-border)]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Отмена
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="px-5 py-2 text-sm bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
