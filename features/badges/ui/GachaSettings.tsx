'use client';
// Настройки гачи (админ): пул тиров с редактируемыми шансами (ppm, сохранение
// всех разом — сервер валидирует сумму ровно 100%), вкл/выкл тиров и всей гачи,
// цена крутки, лимиты, счётчик выданных джекпотов.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface TierRow {
  id: number; tierKey: string; name: string; icon: string; rarity: string;
  prizeType: 'eball' | 'item'; eballAmount: number | null; itemName: string | null;
  itemStock: number | null; chancePpm: number; enabled: boolean;
}
interface GachaAdmin {
  enabled: boolean; spinCost: number; dailyLimit: number; weeklyLimit: number;
  jackpotsGiven: number; ppmTotal: number; pool: TierRow[];
}

export function GachaSettingsBlock({ currencyName }: { currencyName: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const { data } = useQuery<GachaAdmin>({
    queryKey: ['settings-gacha'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges/gacha');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (data) setDraft(Object.fromEntries(data.pool.map(t => [t.id, String(t.chancePpm)])));
  }, [data]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['settings-gacha'] });
    void qc.invalidateQueries({ queryKey: ['gacha'] });
  };
  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch('/api/settings/badges/gacha', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => { setError(null); invalidate(); },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const sumDraft = Object.values(draft).reduce((s, v) => s + (Number(v) || 0), 0);
  const dirty = data ? data.pool.some(t => Number(draft[t.id] ?? t.chancePpm) !== t.chancePpm) : false;

  if (!data) return null;
  return (
    <div className="mb-5 mt-8 border-t border-[var(--color-border)] pt-5">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">🎰 Гача</h2>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
          <input type="checkbox" checked={data.enabled} onChange={e => patch.mutate({ enabled: e.target.checked })} />
          включена
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
          Крутка, {currencyName}
          <NumInput value={data.spinCost} onCommit={v => patch.mutate({ spinCost: v })} w="w-14" />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
          Лимит/день
          <NumInput value={data.dailyLimit} onCommit={v => patch.mutate({ dailyLimit: v })} w="w-12" />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
          /нед
          <NumInput value={data.weeklyLimit} onCommit={v => patch.mutate({ weeklyLimit: v })} w="w-12" />
        </label>
        <span className="ml-auto text-xs text-[var(--color-text-muted)]">
          Выдано джекпотов: <b className="text-[var(--color-text)]">{data.jackpotsGiven}</b>
        </span>
      </div>
      <div className="mb-2 text-xs text-[var(--color-text-muted)]">
        Шансы — в ppm (1 000 000 = 100%); сумма включённых тиров обязана быть ровно 100%, сервер отбивает иное.
        Тиры-предметы с нулевым стоком автоматически выпадают из ролла (джекпот при выданном айфоне невозможен).
      </div>
      <div className="flex flex-col gap-1.5">
        {data.pool.map(t => (
          <div key={t.id} className={`flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-border)] px-3 py-2 ${t.enabled ? '' : 'opacity-60'}`}>
            <span className="text-lg">{t.icon}</span>
            <div className="min-w-0 flex-1">
              <span className="text-sm font-semibold text-[var(--color-text)]">{t.name}</span>
              <span className="ml-2 text-[11px] uppercase text-[var(--color-text-muted)]">{t.rarity}</span>
              {t.prizeType === 'item' && (
                <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                  {t.itemName} · сток {t.itemStock === null ? '∞' : t.itemStock}
                </span>
              )}
              {t.prizeType === 'eball' && <span className="ml-2 text-xs text-[var(--color-text-muted)]">+{t.eballAmount} {currencyName}</span>}
            </div>
            <input value={draft[t.id] ?? String(t.chancePpm)}
              onChange={e => setDraft(d => ({ ...d, [t.id]: e.target.value }))}
              className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-right text-xs tabular-nums" />
            <span className="w-20 text-right text-xs tabular-nums text-[var(--color-text-muted)]">
              {((Number(draft[t.id] ?? t.chancePpm) || 0) / 10000).toLocaleString('ru-RU', { maximumFractionDigits: 4 })}%
            </span>
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
              <input type="checkbox" checked={t.enabled}
                onChange={e => patch.mutate({ tier: { id: t.id, enabled: e.target.checked } })} />
              вкл
            </label>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className={`text-xs tabular-nums ${sumDraft === data.ppmTotal ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-negative,#e03131)] font-semibold'}`}>
          Сумма: {sumDraft.toLocaleString('ru-RU')} ppm ({(sumDraft / 10000).toLocaleString('ru-RU', { maximumFractionDigits: 4 })}%)
        </span>
        <button type="button" disabled={!dirty || patch.isPending}
          onClick={() => patch.mutate({ tiers: data.pool.map(t => ({ id: t.id, chancePpm: Number(draft[t.id] ?? t.chancePpm) || 0 })) })}
          className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">
          Сохранить шансы
        </button>
        {error && <span className="text-xs text-[var(--color-negative,#e03131)]">{error}</span>}
      </div>
    </div>
  );
}

function NumInput({ value, onCommit, w }: { value: number; onCommit: (v: number) => void; w: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const v = Number(draft);
    if (draft === null || !Number.isInteger(v) || v <= 0 || v === value) { setDraft(null); return; }
    onCommit(v); setDraft(null);
  };
  return (
    <input value={draft ?? String(value)} onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); }}
      className={`${w} rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-right text-xs tabular-nums`} />
  );
}
