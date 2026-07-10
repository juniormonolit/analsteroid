'use client';
import { useState, useEffect, useMemo } from 'react';
import { Modal } from '@/components/ui/Modal';
import { PERM_SECTIONS } from '@/lib/auth/perms';

// Права v2: персональные исключения видимости разделов — доп. галки лично
// юзеру, союз с правами его роли (lib/auth/session.ts union'ит их в
// session.permissions). Разделы, уже открытые ролью, показываются отмеченными
// и заблокированными — трогать их тут бессмысленно (снять роль нельзя, это
// не отменяет право роли). Выдавать могут и админы (action.users.manage), и
// супер-админ — см. app/api/admin/users/[id]/overrides/route.ts.

interface Props {
  userId: string;
  userName: string;
  rolePermissions: string[]; // права текущей роли пользователя — для disabled-состояния
  onClose: () => void;
  onSaved: () => void;
}

export function PersonalOverridesModal({ userId, userName, rolePermissions, onClose, onSaved }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roleSet = useMemo(() => new Set(rolePermissions), [rolePermissions]);

  useEffect(() => {
    fetch(`/api/admin/users/${userId}/overrides`)
      .then((r) => r.json())
      .then((d: { sectionOverrides?: string[] }) => setSelected(new Set(d.sectionOverrides ?? [])))
      .catch(() => setError('Не удалось загрузить исключения'))
      .finally(() => setLoading(false));
  }, [userId]);

  function toggle(key: string) {
    if (roleSet.has(key)) return; // уже даёт роль — переключать нечего
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/overrides`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionOverrides: Array.from(selected) }),
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
      title={`Личные исключения — ${userName}`}
      desktopWidth="sm:max-w-[440px]"
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-[var(--color-text-muted)]">
          Доп. разделы лично этому пользователю — в союзе с тем, что уже даёт его роль.
          Разделы, отмеченные серым, уже открыты ролью.
        </p>

        <div className="border border-[var(--color-border)] rounded-lg py-1">
          {loading ? (
            <div className="px-3 py-4 text-sm text-[var(--color-text-muted)]">Загрузка...</div>
          ) : (
            PERM_SECTIONS.map((p) => {
              const fromRole = roleSet.has(p.key);
              const checked = fromRole || selected.has(p.key);
              return (
                <label
                  key={p.key}
                  className={`flex items-center gap-2 py-1.5 px-3 ${fromRole ? 'opacity-60' : 'cursor-pointer hover:bg-[var(--color-bg-hover)]'}`}
                  title={fromRole ? 'Уже открыто ролью' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={fromRole}
                    onChange={() => toggle(p.key)}
                    className="accent-[var(--color-accent)] w-4 h-4 shrink-0"
                  />
                  <span className="text-sm text-[var(--color-text)]">{p.label}</span>
                </label>
              );
            })
          )}
        </div>

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
            disabled={loading || saving}
            className="px-5 py-2 text-sm bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
