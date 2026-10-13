'use client';
// Настройки → «Карточка клиента» (решение владельца 13.10): N — сколько дней
// после последней отгрузки объект клиента считается «В работе». Дальше, если нет
// активных сделок, — «Завершён». По умолчанию 90.

import { useEffect, useState } from 'react';

export default function ClientCardSettingsPage() {
  const [days, setDays] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const [available, setAvailable] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/modules/client-card/settings').then(r => r.json()).then(d => {
      if (d.error) { setMsg(d.error); return; }
      setDays(String(d.days)); setSaved(d.days); setAvailable(!!d.available);
    }).catch(() => setMsg('Не удалось загрузить настройки'));
  }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    const r = await fetch('/api/modules/client-card/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: Number(days) }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(j.error ?? 'Не удалось сохранить'); return; }
    setSaved(j.days); setMsg('Сохранено');
  };

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="max-w-2xl px-4 py-4 sm:px-6 sm:py-6">
        <h1 className="text-lg font-semibold">Карточка клиента</h1>
        <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">
          Статусы объектов клиента: «Новый» — заведён менеджером вручную; «В работе» — есть активная сделка или с последней
          отгрузки прошло не больше N дней; «Завершён» — вручную менеджером или больше N дней без отгрузок и без активных сделок.
        </p>
        <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
          <label className="block text-sm font-semibold" htmlFor="active-days">N — дней «в работе» после последней отгрузки</label>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input id="active-days" type="number" min={7} max={730} value={days} onChange={e => setDays(e.target.value)}
              className="h-11 w-28 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base sm:text-sm" />
            <button type="button" onClick={() => void save()} disabled={busy || !available || !days || Number(days) === saved}
              className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-semibold text-white disabled:opacity-40">Сохранить</button>
          </div>
          {!available && <p className="mt-2 text-[12px] text-[var(--color-text-muted)]">Пока действует значение по умолчанию (90). Изменить можно после миграции sa_org/006.</p>}
          {msg && <p className="mt-2 text-[12px]">{msg}</p>}
        </div>
      </div>
    </div>
  );
}
