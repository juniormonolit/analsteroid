'use client';

import { useState, useEffect } from 'react';

export default function WorkingCalendarPage() {
  const [years, setYears] = useState<number[]>([]);
  const [total, setTotal] = useState(0);
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/settings/working-calendar')
      .then(r => r.json())
      .then(d => {
        setYears(d.years ?? []);
        setTotal(d.total ?? 0);
      })
      .catch(() => {});
  }, []);

  async function handleLoad() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/settings/working-calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error ?? 'Ошибка загрузки' });
      } else {
        setMessage({ type: 'success', text: `Загружено ${data.inserted} дней за ${year} год` });
        // Refresh years list
        const r2 = await fetch('/api/settings/working-calendar');
        const d2 = await r2.json();
        setYears(d2.years ?? []);
        setTotal(d2.total ?? 0);
      }
    } catch {
      setMessage({ type: 'error', text: 'Сетевая ошибка' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-xl">
      <h1 className="text-lg font-semibold text-[var(--color-text)] mb-6">
        Производственный календарь
      </h1>

      <div className="mb-6 p-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
        <p className="text-sm text-[var(--color-text-secondary)] mb-1">Загруженные годы</p>
        {total === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">нет данных</p>
        ) : (
          <p className="text-sm text-[var(--color-text)]">{years.join(', ')}</p>
        )}
      </div>

      <div className="p-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
        <p className="text-sm font-medium text-[var(--color-text)] mb-3">Загрузить / обновить год</p>
        <div className="flex gap-3 items-center">
          <input
            type="number"
            value={year}
            onChange={e => setYear(Number(e.target.value))}
            min={2000}
            max={2100}
            className="w-28 px-3 py-1.5 text-sm rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
          />
          <button
            onClick={handleLoad}
            disabled={loading}
            className="px-4 py-1.5 text-sm rounded bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {loading ? 'Загрузка...' : 'Загрузить / обновить'}
          </button>
        </div>

        {message && (
          <p className={`mt-3 text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-500'}`}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
