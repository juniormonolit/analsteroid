'use client';
import { useEffect, useState } from 'react';
import { Modal } from './Modal';

// Смена пина (задача #2995, спека §5): старый пин + пароль аккаунта (SSO —
// только старый пин). ВНЕ <form> — та же защита от менеджеров паролей, что и
// PinDialog/PinSetupDialog.

export interface PinChangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ssoAccount: boolean;
  onSuccess: (result: { pinFreezeUntil: string | null }) => void;
}

const fieldClass =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]';

export function PinChangeDialog({ open, onOpenChange, ssoAccount, onSuccess }: PinChangeDialogProps) {
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newPinConfirm, setNewPinConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) { setOldPin(''); setNewPin(''); setNewPinConfirm(''); setPassword(''); setError(null); setPending(false); }
  }, [open]);

  async function submit() {
    if (!/^\d{4}$/.test(oldPin)) { setError('Введите текущий пин (4 цифры)'); return; }
    if (!/^\d{4}$/.test(newPin)) { setError('Новый пин — ровно 4 цифры'); return; }
    if (newPin !== newPinConfirm) { setError('Новые пины не совпадают'); return; }
    if (!ssoAccount && !password) { setError('Введите пароль аккаунта'); return; }
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/me/pin', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'change', oldPin, newPin, newPinConfirm, password: ssoAccount ? undefined : password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? 'Не удалось сменить пин'); return; }
      onOpenChange(false);
      onSuccess({ pinFreezeUntil: data.pinFreezeUntil ?? null });
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Смена пина" desktopWidth="sm:max-w-sm">
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium">Текущий пин</label>
          <input type="password" inputMode="numeric" maxLength={4} autoComplete="off"
            data-1p-ignore="" data-lpignore="true" data-bwignore=""
            value={oldPin} onChange={(e) => setOldPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            className={`${fieldClass} text-center tracking-[0.6em]`} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Новый пин</label>
          <input type="password" inputMode="numeric" maxLength={4} autoComplete="off"
            data-1p-ignore="" data-lpignore="true" data-bwignore=""
            value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            className={`${fieldClass} text-center tracking-[0.6em]`} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Повторите новый пин</label>
          <input type="password" inputMode="numeric" maxLength={4} autoComplete="off"
            data-1p-ignore="" data-lpignore="true" data-bwignore=""
            value={newPinConfirm} onChange={(e) => setNewPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 4))}
            className={`${fieldClass} text-center tracking-[0.6em]`} />
        </div>
        {!ssoAccount && (
          <div>
            <label className="mb-1 block text-xs font-medium">Пароль аккаунта (подтверждение)</label>
            <input type="password" autoComplete="off" data-1p-ignore="" data-lpignore="true" data-bwignore=""
              value={password} onChange={(e) => setPassword(e.target.value)}
              className={fieldClass} />
          </div>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button type="button" disabled={pending} onClick={() => void submit()}
          className="w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {pending ? 'Сохраняем…' : 'Сменить пин'}
        </button>
      </div>
    </Modal>
  );
}
