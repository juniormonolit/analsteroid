'use client';

import { useEffect, useState } from 'react';

// Ключи ДОЛЖНЫ буквально совпадать с lib/settings/cardTemplates.ts (не импортируем
// оттуда напрямую — тот модуль тянет systemDb, server-only; тот же паттерн, что
// app/(app)/settings/scoring-weights/page.tsx).
type AxisKey =
  | 'cr_deal_to_reservation' | 'cr_reservation_to_sale' | 'sales_amount' | 'avg_check'
  | 'touch_speed' | 'refusal_rate' | 'cr_reservation_to_confirmed' | 'shipment_rate';
type TileKey = 'reservations' | 'confirmedReservations' | 'salesCount' | 'salesAmount' | 'shipments' | 'avgCheck';
type TemplateKey = 'manager' | 'department';

const AXIS_LABELS: Record<AxisKey, string> = {
  cr_deal_to_reservation: 'CR Сделка → Бронь',
  cr_reservation_to_sale: 'CR Бронь → Продажа',
  sales_amount: 'Сумма продаж',
  avg_check: 'Средний чек',
  touch_speed: 'Скорость касания (меньше — лучше)',
  refusal_rate: 'Доля отказов (меньше — лучше)',
  cr_reservation_to_confirmed: 'CR Бронь → Подтверждена',
  shipment_rate: 'Доля отгруженного от проданного',
};
const AXIS_CATALOG: AxisKey[] = [
  'cr_deal_to_reservation', 'cr_reservation_to_sale', 'sales_amount', 'avg_check',
  'touch_speed', 'refusal_rate', 'cr_reservation_to_confirmed', 'shipment_rate',
];
const MAX_AXES = 6;

const TILE_LABELS: Record<TileKey, string> = {
  reservations: 'Брони',
  confirmedReservations: 'Подтв. брони',
  salesCount: 'Продажи, шт',
  salesAmount: 'Продажи, ₽',
  shipments: 'Отгрузки',
  avgCheck: 'Средний чек',
};
const TILE_CATALOG: TileKey[] = ['reservations', 'confirmedReservations', 'salesCount', 'salesAmount', 'shipments', 'avgCheck'];

const TEMPLATES: { key: TemplateKey; label: string }[] = [
  { key: 'manager', label: 'Карточка менеджера' },
  { key: 'department', label: 'Карточка отдела (РОП)' },
];

function AxisChip({ index, axisKey, onRemove }: { index: number; axisKey: AxisKey; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full text-xs font-medium bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
      <span className="font-bold">{index + 1}.</span> {AXIS_LABELS[axisKey]}
      <button onClick={onRemove} className="w-4 h-4 rounded-full hover:bg-[var(--color-accent)]/20 flex items-center justify-center" aria-label="Убрать ось">×</button>
    </span>
  );
}

export default function CardTemplatesPage() {
  const [templateKey, setTemplateKey] = useState<TemplateKey>('manager');
  const [axes, setAxes] = useState<AxisKey[] | null>(null);
  const [tiles, setTiles] = useState<TileKey[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setAxes(null);
    setTiles(null);
    setMessage(null);
    fetch(`/api/settings/card-templates?key=${templateKey}`)
      .then(r => r.json())
      .then(d => {
        setAxes((d.axes as AxisKey[] | undefined) ?? AXIS_CATALOG.slice(0, MAX_AXES));
        setTiles((d.tiles as TileKey[] | undefined) ?? TILE_CATALOG);
      })
      .catch(() => {
        setAxes(AXIS_CATALOG.slice(0, MAX_AXES));
        setTiles(TILE_CATALOG);
      });
  }, [templateKey]);

  function toggleAxis(key: AxisKey) {
    if (!axes) return;
    if (axes.includes(key)) {
      setAxes(axes.filter(a => a !== key));
    } else {
      if (axes.length >= MAX_AXES) {
        setMessage({ type: 'error', text: `Максимум ${MAX_AXES} осей — сначала уберите одну` });
        return;
      }
      setAxes([...axes, key]);
    }
  }

  function toggleTile(key: TileKey) {
    if (!tiles) return;
    setTiles(tiles.includes(key) ? tiles.filter(t => t !== key) : [...tiles, key]);
  }

  async function handleSave() {
    if (!axes || !tiles || saving) return;
    if (axes.length === 0) {
      setMessage({ type: 'error', text: 'Выберите хотя бы одну ось' });
      return;
    }
    if (tiles.length === 0) {
      setMessage({ type: 'error', text: 'Выберите хотя бы одну плитку' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/settings/card-templates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: templateKey, axes, tiles }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error ?? 'Ошибка сохранения' });
      } else {
        setMessage({ type: 'success', text: 'Сохранено — изменения применятся ко всем карточкам этого типа' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Сетевая ошибка' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-3 sm:p-6 max-w-2xl">
      <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">Шаблоны карточек</h1>
      <p className="text-sm text-[var(--color-text-muted)] mb-5">
        Что показывать в карточке менеджера (профиль + ФИФА-сетка «Мой отдел») и в
        карточке отдела (РОП) — до {MAX_AXES} осей паутины (порядок = порядок клика,
        первая ось сверху) и какие плитки итогов выводить. Рейтинг считается по весам
        со страницы «Веса скоринга» — для осей без сохранённого веса (2 новые) вес
        по умолчанию 5. Изменение применяется сразу ко всем карточкам этого типа.
      </p>

      <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm mb-6 w-fit">
        {TEMPLATES.map(t => (
          <button
            key={t.key}
            onClick={() => setTemplateKey(t.key)}
            className={`px-3.5 py-2 transition-colors whitespace-nowrap ${
              templateKey === t.key ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {axes === null || tiles === null ? (
        <div className="text-sm text-[var(--color-text-muted)]">Загрузка...</div>
      ) : (
        <>
          <div className="mb-6">
            <div className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
              Оси паутины ({axes.length}/{MAX_AXES})
            </div>
            {axes.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {axes.map((a, i) => <AxisChip key={a} index={i} axisKey={a} onRemove={() => toggleAxis(a)} />)}
              </div>
            )}
            <div className="border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border)]">
              {AXIS_CATALOG.map(key => (
                <label key={key} className="px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-[var(--color-bg-hover)]">
                  <input
                    type="checkbox"
                    checked={axes.includes(key)}
                    onChange={() => toggleAxis(key)}
                    disabled={!axes.includes(key) && axes.length >= MAX_AXES}
                    className="accent-[var(--color-accent)]"
                  />
                  <span className="text-sm text-[var(--color-text)]">{AXIS_LABELS[key]}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="mb-6">
            <div className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
              Плитки итогов
            </div>
            <div className="border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border)]">
              {TILE_CATALOG.map(key => (
                <label key={key} className="px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-[var(--color-bg-hover)]">
                  <input
                    type="checkbox"
                    checked={tiles.includes(key)}
                    onChange={() => toggleTile(key)}
                    className="accent-[var(--color-accent)]"
                  />
                  <span className="text-sm text-[var(--color-text)]">{TILE_LABELS[key]}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-[var(--color-accent)] text-[var(--color-text-inverse)] disabled:opacity-50"
            >
              {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
            {message && (
              <span className={`text-sm ${message.type === 'success' ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>
                {message.text}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
