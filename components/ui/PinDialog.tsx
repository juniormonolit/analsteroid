'use client';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';

// Диалог подтверждения денежной операции пином (задача #2995, спека
// owners-inbox/monolitika-pin-code-spec.md §6). ВНЕ <form> намеренно — так
// браузерные менеджеры паролей не предлагают сохранить «пароль», а поля
// снабжены data-атрибутами игнора конкретных расширений (1Password/LastPass/
// Bitwarden). Не autoComplete="one-time-code" (на iOS подставляет SMS-код) и
// не "new-password" (провоцирует генератор паролей).

export interface PinDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  /** Возвращает {ok:true} при успехе — вызывающий сам закрывает диалог и
   *  продолжает свой флоу; {ok:false,error} — диалог покажет ошибку и даст ввести заново. */
  onConfirm: (pin: string) => Promise<{ ok: boolean; error?: string }>;
}

export function PinDialog({ open, onOpenChange, title = 'Подтвердите пином', description, onConfirm }: PinDialogProps) {
  const [digits, setDigits] = useState(['', '', '', '']);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const refs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)];

  useEffect(() => {
    if (!open) return;
    setDigits(['', '', '', '']);
    setError(null);
    setPending(false);
    const t = setTimeout(() => refs[0].current?.focus(), 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(pin: string) {
    setPending(true);
    setError(null);
    try {
      const res = await onConfirm(pin);
      if (!res.ok) {
        setError(res.error ?? 'Ошибка');
        setDigits(['', '', '', '']);
        refs[0].current?.focus();
      }
    } finally {
      setPending(false);
    }
  }

  function setDigit(i: number, raw: string) {
    const d = raw.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[i] = d;
    setDigits(next);
    if (d && i < 3) refs[i + 1].current?.focus();
    if (next.every((x) => x !== '')) void submit(next.join(''));
  }

  function onKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs[i - 1].current?.focus();
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} desktopWidth="sm:max-w-xs">
      <div className="space-y-3">
        {description && <p className="text-xs text-[var(--color-text-muted)]">{description}</p>}
        <div className="flex justify-center gap-2">
          {digits.map((d, i) => (
            <input
              key={i}
              ref={refs[i]}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={1}
              autoComplete="off"
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
              disabled={pending}
              value={d}
              onChange={(e) => setDigit(i, e.target.value)}
              onKeyDown={(e) => onKeyDown(i, e)}
              className="tap-target h-12 w-12 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] text-center text-lg font-semibold outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
            />
          ))}
        </div>
        {error && <p className="text-center text-xs text-red-500">{error}</p>}
        {pending && !error && <p className="text-center text-xs text-[var(--color-text-muted)]">Проверяем…</p>}
      </div>
    </Modal>
  );
}
