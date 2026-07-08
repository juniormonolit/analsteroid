'use client';

import { useState, useEffect } from 'react';

type Mode = 'divide20' | 'calendar';

const OPTIONS: { value: Mode; title: string; description: string }[] = [
  {
    value: 'divide20',
    title: '÷ 20 (дефолт)',
    description: 'Дневной план = месячный план ÷ 20 — константа, не зависит от фактического числа будней месяца.',
  },
  {
    value: 'calendar',
    title: 'Производственный календарь',
    description: 'Дневной план = месячный план ÷ рабочих дней месяца по производственному календарю (см. «Календарь», учитывает праздники РФ).',
  },
];

export default function DailyPlanModePage() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/settings/daily-plan-mode')
      .then(r => r.json())
      .then(d => setMode(d.mode ?? 'divide20'))
      .catch(() => setMode('divide20'));
  }, []);

  async function handleSelect(next: Mode) {
    if (next === mode || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/settings/daily-plan-mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error ?? 'Ошибка сохранения' });
      } else {
        setMode(next);
        setMessage({ type: 'success', text: 'Сохранено' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Сетевая ошибка' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-3 sm:p-6 max-w-xl">
      <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">Режим дневного плана</h1>
      <p className="text-sm text-[var(--color-text-muted)] mb-6">
        Влияет на все расчёты дневного/недельного/MTD плана: конструктор отчётов, Сводная, ЛК,
        ежедневный отчёт «Москва». Виден и редактируется только супер-админом.
      </p>

      <div className="border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border)]">
        {OPTIONS.map(opt => (
          <label
            key={opt.value}
            className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            <input
              type="radio"
              name="daily-plan-mode"
              checked={mode === opt.value}
              disabled={mode === null || saving}
              onChange={() => handleSelect(opt.value)}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium text-[var(--color-text)]">{opt.title}</span>
              <span className="block text-xs text-[var(--color-text-muted)] mt-0.5">{opt.description}</span>
            </span>
          </label>
        ))}
      </div>

      {message && (
        <p className={`mt-3 text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-500'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
