'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BrandLogo } from '@/components/ui/BrandLogo';

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
      // На «/», а не на «/home»: стартовый адрес считает сервер (landingFor) —
      // у рядового без прав это ЛК, иначе Главная. Клиенту знать правило незачем,
      // и дублировать его тут нельзя: разъедется (задача 3045, §5).
      router.push('/');
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? 'Неверный логин или пароль');
    }
    setLoading(false);
  }

  // min-h-dvh, а не min-h-screen — правило 7 CLAUDE.md: на мобильном Safari
  // 100vh считается БЕЗ адресной строки, и центрированная карточка входа уезжает
  // частично под неё. Экран входа — первое, что видит человек при холодном старте
  // PWA, поэтому здесь это не мелочь.
  return (
    <div className="min-h-dvh flex items-center justify-center bg-[var(--color-bg)]">
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
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="login" className="block text-sm text-[var(--color-text-muted)] mb-1">Логин</label>
            <input
              id="login"
              type="text"
              value={login}
              onChange={e => setLogin(e.target.value)}
              // text-[16px] sm:text-sm — правило 9 CLAUDE.md: кегль ниже 16px
              // заставляет iOS зумить страницу при фокусе, и человек попадает на
              // увеличенную форму входа, из которой ещё надо выщипываться.
              // min-h-11 — тач-цель 44px (правило 6): py-2 давало 37px.
              className="w-full min-h-11 px-3 py-2 border border-[var(--color-border)] rounded-lg text-[16px] sm:text-sm outline-none focus:border-[var(--color-border-focus)]"
              autoFocus
              required
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm text-[var(--color-text-muted)] mb-1">Пароль</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              // text-[16px] sm:text-sm — правило 9 CLAUDE.md: кегль ниже 16px
              // заставляет iOS зумить страницу при фокусе, и человек попадает на
              // увеличенную форму входа, из которой ещё надо выщипываться.
              // min-h-11 — тач-цель 44px (правило 6): py-2 давало 37px.
              className="w-full min-h-11 px-3 py-2 border border-[var(--color-border)] rounded-lg text-[16px] sm:text-sm outline-none focus:border-[var(--color-border-focus)]"
              required
            />
          </div>
          {error && <p role="alert" className="text-sm text-[var(--color-negative)]">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full min-h-11 py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-text-inverse)] rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
          >
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  );
}
