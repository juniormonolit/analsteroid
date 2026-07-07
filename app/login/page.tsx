'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MeteorLogo } from '@/components/layout/MeteorLogo';

export default function LoginPage() {
  const router = useRouter();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password }),
    });
    if (res.ok) {
      router.push('/sales/by-managers');
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? 'Неверный логин или пароль');
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)]">
      <div className="w-full max-w-sm bg-[var(--color-bg-surface)] rounded-xl shadow-lg p-8">
        <h1 className="flex items-center justify-center gap-2.5 text-xl font-semibold text-[var(--color-text)] mb-6">
          <MeteorLogo size={30} />
          Аналстероид
        </h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm text-[var(--color-text-muted)] mb-1">Логин</label>
            <input
              type="text"
              value={login}
              onChange={e => setLogin(e.target.value)}
              className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-border-focus)]"
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-sm text-[var(--color-text-muted)] mb-1">Пароль</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm outline-none focus:border-[var(--color-border-focus)]"
              autoComplete="current-password"
              required
            />
          </div>
          {error && <p className="text-sm text-[var(--color-negative)]">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
          >
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  );
}
