'use client';
import { useEffect, useState } from 'react';
import { Modal } from './Modal';

// Первичная установка пина (задача #2995, спека §5): пин дважды + пароль
// аккаунта (SSO-логины bx<id> — без пароля, спека §5). ВНЕ <form> — та же
// защита от менеджеров паролей, что и PinDialog.

export interface PinSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Логин вида bx<id> (вход только через Битрикс) не требует пароля (спека
   *  §5). Необязательно — если не передан, компонент сам спросит /api/me. */
  ssoAccount?: boolean;
  onSuccess: (result: { pinFreezeUntil: string | null; pinThresholdMlt: number }) => void;
}

const fieldClass =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]';

export function PinSetupDialog({ open, onOpenChange, ssoAccount: ssoAccountProp, onSuccess }: PinSetupDialogProps) {
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ssoAccountAuto, setSsoAccountAuto] = useState(false);
  const ssoAccount = ssoAccountProp ?? ssoAccountAuto;

  useEffect(() => {
    if (!open) return;
    setPin(''); setPinConfirm(''); setPassword(''); setError(null); setPending(false);
    if (ssoAccountProp === undefined) {
      fetch('/api/me').then(r => r.json()).then((d) => {
        const login = d?.user?.login as string | undefined;
        setSsoAccountAuto(!!login && /^bx\d+$/.test(login));
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit() {
    if (!/^\d{4}$/.test(pin)) { setError('Пин — ровно 4 цифры'); return; }
    if (pin !== pinConfirm) { setError('Пины не совпадают'); return; }
    if (!ssoAccount && !password) { setError('Введите пароль аккаунта'); return; }
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/me/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, pinConfirm, password: ssoAccount ? undefined : password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? 'Не удалось установить пин'); return; }
      onOpenChange(false);
      onSuccess({ pinFreezeUntil: data.pinFreezeUntil ?? null, pinThresholdMlt: data.pinThresholdMlt ?? 30 });
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Установка пина" desktopWidth="sm:max-w-sm">
      <div className="space-y-3">
        <p className="text-xs text-[var(--color-text-muted)]">
          Пин — 4 цифры. Подтверждает списания дороже вашего личного порога (по умолчанию 30 MLT), рубли, переводы,
          подарки и вывод в ЗП — всегда, вне зависимости от суммы.
        </p>
        <div>
          <label className="mb-1 block text-xs font-medium">Новый пин</label>
          <input
            type="password" inputMode="numeric" maxLength={4} autoComplete="off"
            data-1p-ignore="" data-lpignore="true" data-bwignore=""
            value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            className={`${fieldClass} text-center tracking-[0.6em]`}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Повторите пин</label>
          <input
            type="password" inputMode="numeric" maxLength={4} autoComplete="off"
            data-1p-ignore="" data-lpignore="true" data-bwignore=""
            value={pinConfirm} onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 4))}
            className={`${fieldClass} text-center tracking-[0.6em]`}
          />
        </div>
        {!ssoAccount && (
          <div>
            <label className="mb-1 block text-xs font-medium">Пароль аккаунта (подтверждение)</label>
            <input
              type="password" autoComplete="off" data-1p-ignore="" data-lpignore="true" data-bwignore=""
              value={password} onChange={(e) => setPassword(e.target.value)}
              className={fieldClass}
            />
          </div>
        )}
        {error && <p className="text-xs text-[var(--color-negative,#e03131)]">{error}</p>}
        <button
          type="button" disabled={pending} onClick={() => void submit()}
          className="w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? 'Сохраняем…' : 'Установить пин'}
        </button>
      </div>
    </Modal>
  );
}
