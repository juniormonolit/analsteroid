'use client';
import { useState, useEffect, useMemo } from 'react';
import { Modal } from '@/components/ui/Modal';
import type { Role } from './page';

interface Employee {
  bitrix_user_id: string;
  manager_name: string;
  department_name: string | null;
  short_login: string | null;
}

interface Props {
  roles: Role[];
  onInvited: () => void;
  onClose: () => void;
}

function suggestLogin(shortLogin: string | null, name: string): string {
  if (shortLogin) return shortLogin.replace(/^#/, '').toLowerCase();
  return name
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '.')
    .replace(/^\.+|\.+$/g, '');
}

export function InviteUserModal({ roles, onInvited, onClose }: Props) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Employee | null>(null);
  const [login, setLogin] = useState('');
  const [roleId, setRoleId] = useState<string>(() => roles.find((r) => r.name === 'Пользователь')?.id ?? roles[0]?.id ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/org-employees')
      .then((r) => r.json())
      .then((d: { employees?: Employee[] }) => setEmployees(d.employees ?? []))
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees.slice(0, 20);
    return employees.filter((e) => e.manager_name.toLowerCase().includes(q)).slice(0, 20);
  }, [employees, search]);

  function pick(e: Employee) {
    setSelected(e);
    setSearch(e.manager_name);
    setLogin(suggestLogin(e.short_login, e.manager_name));
  }

  async function handleInvite() {
    if (!selected || !login.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          login: login.trim(),
          display_name: selected.manager_name,
          bitrix_user_id: selected.bitrix_user_id,
          role_id: roleId || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Не удалось отправить приглашение');
      } else {
        onInvited();
      }
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
      title="Пригласить пользователя"
      desktopWidth="sm:max-w-[440px]"
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5 relative">
          <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
            Сотрудник (из Bitrix)
          </label>
          <input
            autoFocus
            placeholder="Начните вводить имя..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelected(null);
            }}
            className="w-full border border-[var(--color-border)] rounded-lg px-3 py-2 text-base sm:text-sm bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          {!selected && search.trim() && filtered.length > 0 && (
            <div className="absolute top-full mt-1 left-0 right-0 z-10 max-h-56 overflow-auto bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-lg">
              {filtered.map((e) => (
                <button
                  key={e.bitrix_user_id}
                  onClick={() => pick(e)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--color-bg-hover)] flex flex-col"
                >
                  <span className="text-[var(--color-text)]">{e.manager_name}</span>
                  {e.department_name && (
                    <span className="text-xs text-[var(--color-text-muted)]">{e.department_name}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
              Логин
            </label>
            <input
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              className="w-full border border-[var(--color-border)] rounded-lg px-3 py-2 text-base sm:text-sm bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
            Роль
          </label>
          <select
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            className="w-full border border-[var(--color-border)] rounded-lg px-3 py-2 text-base sm:text-sm bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          >
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
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
            onClick={handleInvite}
            disabled={!selected || !login.trim() || saving}
            className="px-5 py-2 text-sm bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving ? 'Отправка...' : 'Пригласить'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
