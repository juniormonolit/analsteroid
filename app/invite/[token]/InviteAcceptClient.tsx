'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { BrandLogo } from '@/components/ui/BrandLogo';

export function InviteAcceptClient({ token }: { token: string }) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [checkError, setCheckError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch(`/api/invite/${token}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) setCheckError(data.error ?? 'Приглашение недействительно');
        else setDisplayName(data.displayName);
      })
      .catch(() => setCheckError('Сетевая ошибка'))
      .finally(() => setChecking(false));
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Пароль должен быть не короче 8 символов');
      return;
    }
    if (password !== confirm) {
      setError('Пароли не совпадают');
      return;
    }
    setLoading(true);
    const res = await fetch(`/api/invite/${token}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      router.push('/');
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? 'Не удалось принять приглашение');
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)]">
      <div className="w-full max-w-sm bg-[var(--color-bg-surface)] rounded-xl shadow-lg p-8">
        <h1 className="flex flex-col items-center gap-2.5 text-xl font-semibold text-[var(--color-text)] mb-6">
          <span className="flex items-center gap-2.5">
            <BrandLogo size={30} />
            Монолитика
          </span>
          <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            {'— аналитика для монолита'.toUpperCase()}
          </span>
        </h1>

        {checking ? (
          <p className="text-sm text-[var(--color-text-muted)] text-center">Проверка приглашения...</p>
        ) : checkError ? (
          <p className="text-sm text-[var(--color-negative)] text-center">{checkError}</p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <p className="text-sm text-[var(--color-text-muted)] text-center">
              Здравствуйте, {displayName}! Задайте пароль для входа.
            </p>
            <div>
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">Новый пароль</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-border-focus)]"
                autoFocus
                required
              />
            </div>
            <div>
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">Повторите пароль</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-border-focus)]"
                required
              />
            </div>
            {error && <p className="text-sm text-[var(--color-negative)]">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-text-inverse)] rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
            >
              {loading ? 'Сохранение...' : 'Войти'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
