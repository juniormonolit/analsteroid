'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ArrowLeft, CloudSun } from 'lucide-react';

// «Кого спрашивать по погоде» (владелец 28.08): бот «Аналитик» каждый понедельник
// в 09:00 МСК спрашивает этих людей про погоду прошлой недели для спец-отчёта
// «Данные по годам». Гейт — layout раздела «Боты» (section.settings).

const CITY_LABELS: Record<string, string> = { spb: 'Санкт-Петербург', msk: 'Москва', krd: 'Краснодар' };

interface Responsible { city: string; bitrixUserId: string; name: string | null }

export default function WeatherResponsiblesPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ responsibles: Responsible[] }>({
    queryKey: ['weather-responsibles'],
    queryFn: async () => {
      const res = await fetch('/api/settings/weather-responsibles');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: async ({ city, id }: { city: string; id: string }) => {
      const res = await fetch('/api/settings/weather-responsibles', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city, bitrixUserId: id }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Ошибка');
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['weather-responsibles'] }),
  });

  const byCity = new Map((data?.responsibles ?? []).map(r => [r.city, r]));

  return (
    <div className="p-3 sm:p-6 max-w-2xl">
      <Link href="/settings/bots" className="tap-target inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
        <ArrowLeft size={13} /> Боты
      </Link>
      <h1 className="mt-2 mb-1 flex items-center gap-2 text-lg font-semibold text-[var(--color-text)]">
        <CloudSun size={18} className="text-[var(--color-accent)]" /> Кого спрашивать по погоде
      </h1>
      <p className="mb-5 text-sm text-[var(--color-text-muted)]">
        Каждый понедельник в 09:00 МСК «Аналитик» спрашивает этих людей «Как погодка
        на той неделе была?» — ответ попадает в отчёт «Данные по годам». Указывается
        Bitrix ID. Автосводка Open-Meteo добавляется независимо.
      </p>

      {isLoading ? <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div> : (
        <div className="flex flex-col gap-2">
          {(['spb', 'msk', 'krd'] as const).map(city => {
            const cur = byCity.get(city);
            const val = draft[city] ?? cur?.bitrixUserId ?? '';
            return (
              <div key={city} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
                <span className="w-40 text-sm font-semibold text-[var(--color-text)]">{CITY_LABELS[city]}</span>
                <input value={val} onChange={e => setDraft(d => ({ ...d, [city]: e.target.value }))}
                  inputMode="numeric" placeholder="Bitrix ID"
                  className="w-28 min-h-11 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[16px] sm:text-sm text-right tabular-nums" />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-muted)]">
                  {cur?.name ? `сейчас: ${cur.name} (#${cur.bitrixUserId})` : cur ? `сейчас: #${cur.bitrixUserId}` : 'не назначен — дефолт подберётся по имени при первом опросе'}
                </span>
                <button type="button" disabled={save.isPending || !/^\d{1,10}$/.test(val) || val === cur?.bitrixUserId}
                  onClick={() => save.mutate({ city, id: val })}
                  className="min-h-11 rounded-lg bg-[var(--color-accent)] px-3 text-xs font-semibold text-[var(--color-text-inverse)] disabled:opacity-40">
                  Сохранить
                </button>
              </div>
            );
          })}
          {save.isError && <div className="text-xs text-[var(--color-negative,#e03131)]">{String(save.error)}</div>}
        </div>
      )}
    </div>
  );
}
