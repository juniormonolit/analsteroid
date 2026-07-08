'use client';
import { useState, useEffect, useCallback } from 'react';
import { InviteUserModal } from './InviteUserModal';
import { AssignDepartmentsModal } from './AssignDepartmentsModal';

interface AppUser {
  id: string;
  login: string;
  displayName: string;
  isSuperadmin: boolean;
  isActive: boolean;
  bitrixUserId: string | null;
  roleId: string | null;
  roleName: string | null;
  departmentCount: number;
  status: 'active' | 'pending' | 'expired' | 'no_invite';
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}

const STATUS_LABEL: Record<AppUser['status'], string> = {
  active: 'Активен',
  pending: 'Приглашение отправлено',
  expired: 'Приглашение истекло',
  no_invite: 'Без приглашения',
};

const STATUS_CLASS: Record<AppUser['status'], string> = {
  active: 'text-green-600',
  pending: 'text-[var(--color-accent)]',
  expired: 'text-red-500',
  no_invite: 'text-[var(--color-text-muted)]',
};

export default function UsersPage() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [deptUser, setDeptUser] = useState<AppUser | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/admin/users').then((r) => r.json()),
      fetch('/api/admin/roles').then((r) => r.json()),
    ])
      .then(([u, r]: [{ users?: AppUser[] }, { roles?: Role[] }]) => {
        setUsers(u.users ?? []);
        setRoles(r.roles ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function resend(id: string) {
    setBusyId(id);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${id}/resend`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) setMessage({ type: 'error', text: data.error ?? 'Не удалось переслать приглашение' });
      else { setMessage({ type: 'success', text: 'Приглашение отправлено повторно' }); load(); }
    } catch {
      setMessage({ type: 'error', text: 'Сетевая ошибка' });
    } finally {
      setBusyId(null);
    }
  }

  async function patchUser(id: string, patch: Record<string, unknown>, errText: string) {
    setBusyId(id);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) setMessage({ type: 'error', text: data.error ?? errText });
      else load();
    } catch {
      setMessage({ type: 'error', text: 'Сетевая ошибка' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-3 sm:p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Пользователи</h1>
        <button
          onClick={() => setShowInvite(true)}
          className="px-4 py-1.5 text-sm rounded bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
        >
          Пригласить
        </button>
      </div>

      {message && (
        <p className={`mb-4 text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-500'}`}>
          {message.text}
        </p>
      )}

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] scroll-x">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
              <th className="px-4 py-2 font-medium">Имя</th>
              <th className="px-4 py-2 font-medium">Логин</th>
              <th className="px-4 py-2 font-medium">Роль</th>
              <th className="px-4 py-2 font-medium">Статус</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-muted)]">Загрузка...</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-muted)]">Пользователей пока нет</td></tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-2 text-[var(--color-text)]">
                    {u.displayName}
                    {u.isSuperadmin && (
                      <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--color-accent)]" title="Супер-админ: настраивает роли и права">
                        super
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-text-muted)]">{u.login}</td>
                  <td className="px-4 py-2">
                    <select
                      value={u.roleId ?? ''}
                      disabled={busyId === u.id}
                      onChange={(e) => patchUser(u.id, { role_id: e.target.value }, 'Не удалось сменить роль')}
                      className="text-base sm:text-sm bg-[var(--color-bg)] text-[var(--color-text)] border border-[var(--color-border)] rounded px-2 py-1 disabled:opacity-50"
                    >
                      {u.roleId === null && <option value="">Без роли</option>}
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className={`px-4 py-2 ${STATUS_CLASS[u.status]}`}>{STATUS_LABEL[u.status]}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => setDeptUser(u)}
                      className="text-xs text-[var(--color-accent)] hover:underline mr-3"
                      title="Подконтрольные отделы (сводка в ЛК)"
                    >
                      Отделы{u.departmentCount > 0 ? ` (${u.departmentCount})` : ''}
                    </button>
                    {(u.status === 'pending' || u.status === 'expired') && (
                      <button
                        onClick={() => resend(u.id)}
                        disabled={busyId === u.id}
                        className="text-xs text-[var(--color-accent)] hover:underline mr-3 disabled:opacity-50"
                      >
                        Переслать
                      </button>
                    )}
                    <button
                      onClick={() => patchUser(u.id, { is_active: !u.isActive }, 'Не удалось обновить пользователя')}
                      disabled={busyId === u.id}
                      className="text-xs text-[var(--color-text-muted)] hover:underline disabled:opacity-50"
                    >
                      {u.isActive ? 'Деактивировать' : 'Активировать'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showInvite && (
        <InviteUserModal
          roles={roles}
          onClose={() => setShowInvite(false)}
          onInvited={() => { setShowInvite(false); setMessage({ type: 'success', text: 'Приглашение отправлено' }); load(); }}
        />
      )}

      {deptUser && (
        <AssignDepartmentsModal
          userId={deptUser.id}
          userName={deptUser.displayName}
          onClose={() => setDeptUser(null)}
          onSaved={() => { setDeptUser(null); setMessage({ type: 'success', text: 'Отделы сохранены' }); load(); }}
        />
      )}
    </div>
  );
}
