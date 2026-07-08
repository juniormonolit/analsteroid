'use client';
import { useState, useEffect, useCallback } from 'react';
import { RoleEditorModal } from './RoleEditorModal';

export interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/admin/roles')
      .then((r) => r.json())
      .then((d: { roles?: Role[] }) => setRoles(d.roles ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function deleteRole(role: Role) {
    if (!window.confirm(`Удалить роль «${role.name}»?`)) return;
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/roles/${role.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) setMessage({ type: 'error', text: data.error ?? 'Не удалось удалить роль' });
      else { setMessage({ type: 'success', text: `Роль «${role.name}» удалена` }); load(); }
    } catch {
      setMessage({ type: 'error', text: 'Сетевая ошибка' });
    }
  }

  return (
    <div className="p-3 sm:p-6">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Роли</h1>
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-1.5 text-sm rounded bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
        >
          Создать роль
        </button>
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mb-6">
        Роль определяет, какие разделы видит пользователь и какие действия ему доступны.
        Настройка ролей доступна только супер-админу.
      </p>

      {message && (
        <p className={`mb-4 text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-500'}`}>
          {message.text}
        </p>
      )}

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] scroll-x">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
              <th className="px-4 py-2 font-medium">Роль</th>
              <th className="px-4 py-2 font-medium">Описание</th>
              <th className="px-4 py-2 font-medium">Права</th>
              <th className="px-4 py-2 font-medium">Пользователи</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-muted)]">Загрузка...</td></tr>
            ) : roles.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-muted)]">Ролей пока нет</td></tr>
            ) : (
              roles.map((r) => (
                <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-2 text-[var(--color-text)] whitespace-nowrap">
                    {r.name}
                    {r.isSystem && (
                      <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]" title="Системная роль: нельзя удалить или переименовать">
                        системная
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-text-muted)]">{r.description ?? '—'}</td>
                  <td className="px-4 py-2 text-[var(--color-text-muted)]">{r.permissions.length}</td>
                  <td className="px-4 py-2 text-[var(--color-text-muted)]">{r.userCount}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => setEditing(r)}
                      className="text-xs text-[var(--color-accent)] hover:underline mr-3"
                    >
                      Настроить
                    </button>
                    {!r.isSystem && (
                      <button
                        onClick={() => deleteRole(r)}
                        className="text-xs text-red-500 hover:underline disabled:opacity-50"
                        disabled={r.userCount > 0}
                        title={r.userCount > 0 ? 'Роль назначена пользователям — сначала переназначьте их' : undefined}
                      >
                        Удалить
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <RoleEditorModal
          role={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            setMessage({ type: 'success', text: 'Сохранено' });
            load();
          }}
        />
      )}
    </div>
  );
}
