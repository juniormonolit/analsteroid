'use client';
// Настройки → Категории клиентов (дополнение Серёги 01.08): редактируемые пороги
// именных категорий «Моих заказчиков». Категория считается на лету — правка
// действует сразу (кэш списка перечитывать не нужно).

import { useEffect, useState } from 'react';

interface S {
  keyMinShipments: number; keyMinSum: number;
  largeMinSum: number; largeMinShipments: number;
  complexMinGroups: number; frequentFactor: number; fadingFactor: number;
}

const FIELDS: { key: keyof S; label: string; hint: string }[] = [
  { key: 'keyMinShipments', label: '«Ключевой»: отгрузок ≥', hint: 'Правило Серёги: отгрузок ≥ 2 И сумма ≥ 5 млн' },
  { key: 'keyMinSum', label: '«Ключевой»: сумма отгрузок ≥, ₽', hint: 'Оба условия ключевого должны выполниться одновременно' },
  { key: 'largeMinSum', label: '«Крупный»: сумма отгрузок ≥, ₽', hint: 'Крупный = сумма ≥ порога ИЛИ отгрузок ≥ порога ниже' },
  { key: 'largeMinShipments', label: '«Крупный»: отгрузок ≥', hint: 'Достаточно любого из двух условий крупного' },
  { key: 'complexMinGroups', label: '«Комплексный»: разных товарных групп ≥', hint: 'Модификатор 🧩: сколько разных head-групп в отгрузках' },
  { key: 'frequentFactor', label: '«Частый»: цикл < доля × медианы базы', hint: 'Модификатор ⚡: 0.5 = покупает вдвое чаще медианы базы (16 дн.)' },
  { key: 'fadingFactor', label: '«Затухающий»: интервал > × среднего', hint: 'Модификатор 📉: последний интервал (или текущая тишина) больше этого множителя от его среднего' },
];

export default function CustomerCategoriesPage() {
  const [s, setS] = useState<S | null>(null);
  const [defaults, setDefaults] = useState<S | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings/customer-categories').then(r => r.json())
      .then(d => { setS(d.settings); setDefaults(d.defaults); })
      .catch(() => setMsg('Не удалось загрузить настройки'));
  }, []);

  async function save() {
    if (!s || saving) return;
    setSaving(true); setMsg(null);
    try {
      const res = await fetch('/api/settings/customer-categories', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s),
      });
      const d = await res.json();
      if (!res.ok) setMsg(d.error ?? 'Ошибка сохранения');
      else { setS(d.settings); setMsg('Сохранено — категории в «Моих заказчиках» пересчитаются при следующем открытии списка'); }
    } catch { setMsg('Сетевая ошибка'); }
    finally { setSaving(false); }
  }

  if (!s) return <div className="p-6 text-sm text-[var(--color-text-muted)]">{msg ?? 'Загрузка…'}</div>;

  return (
    <div className="max-w-2xl p-6 flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-[var(--color-text)]">Категории клиентов</h1>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          Именные категории «Моих заказчиков»: 🔑 Ключевой → Крупный → Постоянный (2+ покупки) → Разовый →
          Потенциальный (покупок нет, есть активные). «Отгрузка» = факт отгрузки сделки (как «покупка»
          в отчёте «Повторные»). Правки действуют сразу.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {FIELDS.map(f => (
          <label key={f.key} className="flex items-center justify-between gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-2.5">
            <span>
              <span className="block text-sm font-semibold text-[var(--color-text)]">{f.label}</span>
              <span className="block text-[11px] text-[var(--color-text-muted)]">{f.hint}{defaults ? ` · дефолт: ${defaults[f.key]}` : ''}</span>
            </span>
            <input
              type="number" step="any" value={s[f.key]}
              onChange={e => setS({ ...s, [f.key]: Number(e.target.value) })}
              className="w-36 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-right tabular-nums"
            />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={saving}
          className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-text-inverse)] disabled:opacity-50">
          Сохранить
        </button>
        {msg && <span className="text-xs text-[var(--color-text-muted)]">{msg}</span>}
      </div>
    </div>
  );
}
