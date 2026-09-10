'use client';
import { useState, useEffect, useCallback } from 'react';
import { PERM_SECTIONS, PERM_ACTIONS, ALL_SECTIONS_PERM, MORE_MENU_PERMS, hasAllSections } from '@/lib/auth/perms';

// Пункты меню «Ещё» — отдельная таблица (задача Иосифа 10.09). Их ключи не
// дублируем в «Видимости разделов»/«Действиях»: один ключ — один чекбокс.
const MORE_KEYS = new Set<string>(MORE_MENU_PERMS.map((p) => p.key));
const SECTION_ITEMS = PERM_SECTIONS.filter((p) => !MORE_KEYS.has(p.key));
const ACTION_ITEMS = PERM_ACTIONS.filter((p) => !MORE_KEYS.has(p.key));

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
  withAllSections,
  jokerCoversSections,
}: {
  title: string;
  hint?: string;
  items: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  roles: Role[];
  busyCell: string | null; // `${roleId}:${key}`
  onToggle: (role: Role, key: string) => void;
  // Для таблицы разделов: первый столбец — джокер «Все разделы» (ALL_SECTIONS_PERM).
  // Роль с ним автоматически видит и будущие разделы, поэтому остальные ячейки
  // строки показываем отмеченными и заблокированными.
  withAllSections?: boolean;
  // Таблица «Пункты меню „Ещё“»: своей колонки джокера нет, но джокер роли
  // покрывает её section.*-ключи (hasPerm пропускает любой section.*) — такие
  // ячейки показываем отмеченными и заблокированными. action.*-ключи («Чаты»)
  // джокер не покрывает — их чекбокс остаётся живым.
  jokerCoversSections?: boolean;
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
              {withAllSections && (
                <th className="px-3 py-2 font-medium text-center whitespace-nowrap text-[var(--color-text)]">
                  Все разделы
                </th>
              )}
              {items.map((p) => (
                <th key={p.key} className="px-3 py-2 font-medium text-center whitespace-nowrap">{p.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => {
              const allSections = (withAllSections || jokerCoversSections) && hasAllSections(r.permissions);
              return (
                <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-2 text-[var(--color-text)] whitespace-nowrap sticky left-0 bg-[var(--color-bg-surface)]">
                    {r.name}
                  </td>
                  {withAllSections && (
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={!!allSections}
                        disabled={busyCell === `${r.id}:${ALL_SECTIONS_PERM}`}
                        onChange={() => onToggle(r, ALL_SECTIONS_PERM)}
                        className="accent-[var(--color-accent)] w-4 h-4"
                        title="Роль видит все разделы, включая будущие"
                      />
                    </td>
                  )}
                  {items.map((p) => {
                    const cellKey = `${r.id}:${p.key}`;
                    // Джокер покрывает только section.* — «Чаты» (action.deal_chats)
                    // в таблице «Ещё» остаются самостоятельным чекбоксом.
                    const jokered = allSections && p.key.startsWith('section.');
                    const checked = jokered || r.permissions.includes(p.key);
                    return (
                      <td key={p.key} className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busyCell === cellKey || jokered}
                          onChange={() => onToggle(r, p.key)}
                          className="accent-[var(--color-accent)] w-4 h-4"
                          title={jokered ? 'Включено правом «Все разделы»' : undefined}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
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
            hint="«Все разделы» — джокер: роль автоматически видит и те разделы, которые появятся позже"
            withAllSections
            items={SECTION_ITEMS}
            roles={roles}
            busyCell={busyCell}
            onToggle={toggle}
          />
          <MatrixTable
            title="Пункты меню «Ещё»"
            hint="Каждый пункт доступен администраторам всегда; галка открывает его роли. Джокер «Все разделы» покрывает всё, кроме «Чатов» (это действие). Данные внутри разделов режутся зоной ответственности пользователя."
            jokerCoversSections
            items={MORE_MENU_PERMS}
            roles={roles}
            busyCell={busyCell}
            onToggle={toggle}
          />
          <MatrixTable
            title="Действия"
            hint="Право на конкретное действие, не на просмотр раздела"
            items={ACTION_ITEMS}
            roles={roles}
            busyCell={busyCell}
            onToggle={toggle}
          />
        </>
      )}
    </div>
  );
}
