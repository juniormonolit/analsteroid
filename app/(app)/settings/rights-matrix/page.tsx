'use client';
import { useState, useEffect, useCallback } from 'react';
import { PERM_SECTIONS, PERM_ACTIONS } from '@/lib/auth/perms';

// Права v2: матрица роль × раздел (+ отдельно роль × действие) с чекбоксами,
// видна только супер-админу (гейт в layout.tsx). Каждый чекбокс сразу PATCH'ит
// /api/admin/roles/{id} — переиспользуем существующий эндпоинт (тот же, что
// использует RoleEditorModal на /settings/roles), просто другое представление
// того же самого roles.permissions.

interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}

function MatrixTable({
  title,
  hint,
  items,
  roles,
  busyCell,
  onToggle,
}: {
  title: string;
  hint?: string;
  items: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  roles: Role[];
  busyCell: string | null; // `${roleId}:${key}`
  onToggle: (role: Role, key: string) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
        {hint && <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{hint}</p>}
      </div>
      <div className="scroll-x">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
              <th className="px-4 py-2 font-medium sticky left-0 bg-[var(--color-bg-surface)]">Роль</th>
              {items.map((p) => (
                <th key={p.key} className="px-3 py-2 font-medium text-center whitespace-nowrap">{p.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0">
                <td className="px-4 py-2 text-[var(--color-text)] whitespace-nowrap sticky left-0 bg-[var(--color-bg-surface)]">
                  {r.name}
                </td>
                {items.map((p) => {
                  const cellKey = `${r.id}:${p.key}`;
                  const checked = r.permissions.includes(p.key);
                  return (
                    <td key={p.key} className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busyCell === cellKey}
                        onChange={() => onToggle(r, p.key)}
                        className="accent-[var(--color-accent)] w-4 h-4"
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function RightsMatrixPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyCell, setBusyCell] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/admin/roles')
      .then((r) => r.json())
      .then((d: { roles?: Role[] }) => setRoles(d.roles ?? []))
      .catch(() => setError('Не удалось загрузить роли'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggle(role: Role, key: string) {
    const cellKey = `${role.id}:${key}`;
    setBusyCell(cellKey);
    setError(null);
    const has = role.permissions.includes(key);
    const nextPermissions = has ? role.permissions.filter((p) => p !== key) : [...role.permissions, key];

    // Оптимистичное обновление — таблица большая, ждать перезагрузки всех ролей на каждый клик неудобно.
    setRoles((prev) => prev.map((r) => (r.id === role.id ? { ...r, permissions: nextPermissions } : r)));

    try {
      const res = await fetch(`/api/admin/roles/${role.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: nextPermissions }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Не удалось сохранить изменение');
        load(); // откат к серверному состоянию
      }
    } catch {
      setError('Сетевая ошибка');
      load();
    } finally {
      setBusyCell(null);
    }
  }

  return (
    <div className="p-3 sm:p-6 flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Матрица прав</h1>
        <p className="text-xs text-[var(--color-text-muted)] mt-1">
          Чекбокс сразу меняет права роли — действует на всех пользователей с этой ролью.
          Изменения существующих системных ролей (Администратор, Пользователь) здесь —
          осознанное решение, применяется мгновенно.
        </p>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {loading ? (
        <p className="text-sm text-[var(--color-text-muted)]">Загрузка...</p>
      ) : (
        <>
          <MatrixTable
            title="Видимость разделов"
            items={PERM_SECTIONS}
            roles={roles}
            busyCell={busyCell}
            onToggle={toggle}
          />
          <MatrixTable
            title="Действия"
            hint="Право на конкретное действие, не на просмотр раздела"
            items={PERM_ACTIONS}
            roles={roles}
            busyCell={busyCell}
            onToggle={toggle}
          />
        </>
      )}
    </div>
  );
}
