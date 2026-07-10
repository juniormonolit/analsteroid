'use client';
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = repeat.length > 0 && newPassword !== repeat;
  const tooShort = newPassword.length > 0 && newPassword.length < 8;
  const canSave = oldPassword && newPassword.length >= 8 && newPassword === repeat && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/me/password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Не удалось сменить пароль');
      else setDone(true);
    } catch {
      setError('Сетевая ошибка');
    } finally {
      setSaving(false);
    }
  }

  const inputCls =
    'w-full border border-[var(--color-border)] rounded-lg px-3 py-2 text-base sm:text-sm bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]';

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="Сменить пароль"
      desktopWidth="sm:max-w-[400px]"
    >
      {done ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-text)]">
            Пароль изменён. Остальные устройства разлогинены.
          </p>
          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="px-5 py-2 text-sm bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-lg hover:opacity-90 transition-opacity"
            >
              Готово
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
              Текущий пароль
            </label>
            <input type="password" autoFocus autoComplete="current-password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} className={inputCls} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
              Новый пароль
            </label>
            <input type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={inputCls} />
            {tooShort && <span className="text-xs text-red-500">Не короче 8 символов</span>}
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
              Новый пароль ещё раз
            </label>
            <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }} className={inputCls} />
            {mismatch && <span className="text-xs text-red-500">Пароли не совпадают</span>}
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
              disabled={!canSave}
              className="px-5 py-2 text-sm bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {saving ? 'Сохранение...' : 'Сменить'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
