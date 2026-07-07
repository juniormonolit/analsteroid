'use client';
import { useState, useEffect, useCallback } from 'react';
import { InviteUserModal } from './InviteUserModal';

interface AppUser {
  id: string;
  login: string;
  displayName: string;
  isAdmin: boolean;
  isActive: boolean;
  bitrixUserId: string | null;
  status: 'active' | 'pending' | 'expired' | 'no_invite';
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
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/admin/users')
      .then((r) => r.json())
      .then((d: { users?: AppUser[] }) => setUsers(d.users ?? []))
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

  async function toggleActive(u: AppUser) {
    setBusyId(u.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${u.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !u.isActive }),
      });
      const data = await res.json();
      if (!res.ok) setMessage({ type: 'error', text: data.error ?? 'Не удалось обновить пользователя' });
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
        <table className="w-full min-w-[560px] text-sm">
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
                  <td className="px-4 py-2 text-[var(--color-text)]">{u.displayName}</td>
                  <td className="px-4 py-2 text-[var(--color-text-muted)]">{u.login}</td>
                  <td className="px-4 py-2 text-[var(--color-text)]">{u.isAdmin ? 'Администратор' : 'Пользователь'}</td>
                  <td className={`px-4 py-2 ${STATUS_CLASS[u.status]}`}>{STATUS_LABEL[u.status]}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
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
                      onClick={() => toggleActive(u)}
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
          onClose={() => setShowInvite(false)}
          onInvited={() => { setShowInvite(false); setMessage({ type: 'success', text: 'Приглашение отправлено' }); load(); }}
        />
      )}
    </div>
  );
}
