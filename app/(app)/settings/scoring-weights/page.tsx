'use client';

import { useEffect, useState } from 'react';

// Ключи ДОЛЖНЫ буквально совпадать с AxisKey (lib/settings/scoringWeights.ts) — не
// импортируем оттуда напрямую: тот модуль тянет systemDb (pg/fs, server-only), а
// это клиентский компонент ('use client'), импорт сломал бы сборку браузерного бандла.
type AxisKey = 'cr_deal_to_reservation' | 'cr_reservation_to_sale' | 'sales_amount' | 'avg_check' | 'touch_speed' | 'refusal_rate';
const AXIS_KEYS: AxisKey[] = [
  'cr_deal_to_reservation', 'cr_reservation_to_sale', 'sales_amount', 'avg_check', 'touch_speed', 'refusal_rate',
];

const AXIS_LABELS: Record<AxisKey, string> = {
  cr_deal_to_reservation: 'CR Сделка → Бронь',
  cr_reservation_to_sale: 'CR Бронь → Продажа',
  sales_amount: 'Сумма продаж',
  avg_check: 'Средний чек',
  touch_speed: 'Скорость касания (меньше — лучше)',
  refusal_rate: 'Доля отказов (меньше — лучше)',
};

type Weights = Record<AxisKey, number>;
const EQUAL: Weights = Object.fromEntries(AXIS_KEYS.map(k => [k, 5])) as Weights;

export default function ScoringWeightsPage() {
  const [weights, setWeights] = useState<Weights | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/settings/scoring-weights')
      .then(r => r.json())
      .then(d => setWeights(d.weights ?? EQUAL))
      .catch(() => setWeights(EQUAL));
  }, []);

  const sum = weights ? AXIS_KEYS.reduce((s, k) => s + weights[k], 0) : 0;

  async function handleSave() {
    if (!weights || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/settings/scoring-weights', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weights }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error ?? 'Ошибка сохранения' });
      } else {
        setMessage({ type: 'success', text: 'Сохранено' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Сетевая ошибка' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-3 sm:p-6 max-w-2xl">
      <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">Веса скоринга карточки менеджера</h1>
      <p className="text-sm text-[var(--color-text-muted)] mb-6">
        Влияет на рейтинг в карточке менеджера, ФИФА-сетке «Мой отдел» и карточке отдела —
        взвешенное среднее нормированных (0-10) значений 6 осей паутины. Шкала осей 0-10,
        сумма нормируется автоматически (не обязана давать 10). Дефолт — равные веса
        (эквивалент простого среднего, как в исходной карточке v1). Видна и редактируется
        только супер-админом.
      </p>

      {weights === null ? (
        <div className="text-sm text-[var(--color-text-muted)]">Загрузка...</div>
      ) : (
        <>
          <div className="border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border)]">
            {AXIS_KEYS.map(key => (
              <div key={key} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <span className="text-sm text-[var(--color-text)] sm:w-64 shrink-0">{AXIS_LABELS[key]}</span>
                <input
                  type="range" min={0} max={10} step={1}
                  value={weights[key]}
                  onChange={e => setWeights({ ...weights, [key]: Number(e.target.value) })}
                  className="flex-1 accent-[var(--color-accent)]"
                />
                <span className="text-sm font-semibold text-[var(--color-text)] w-8 text-right shrink-0">{weights[key]}</span>
              </div>
            ))}
          </div>

          <div className="mt-3 text-xs text-[var(--color-text-muted)]">
            Сумма: {sum} {sum === 0 && '— все веса 0, будет применён фолбэк на равные доли'}
          </div>

          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-[var(--color-accent)] text-white disabled:opacity-50"
            >
              {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
            <button
              onClick={() => setWeights(EQUAL)}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-border-focus)]"
            >
              Сбросить на равные
            </button>
            {message && (
              <span className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-500'}`}>
                {message.text}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
