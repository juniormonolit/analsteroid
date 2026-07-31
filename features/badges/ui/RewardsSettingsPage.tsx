'use client';

// «Настройки → Награды» (задача 2655, этап 1): каталог бейджей — вкл/выкл,
// редактирование числовых порогов criteria, счётчики выдач. Конструктора
// НОВЫХ наград нет (этап 2, решение владельца).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';

interface Row {
  key: string; name: string; description: string; icon: string; category: string;
  tiered: boolean; criteria: Record<string, unknown>; enabled: boolean;
  awards: number; holders: number;
  // Цены валюты (задача 2657): {'-': цена} или {bronze..platinum: цена}.
  prices: Record<string, number>;
}

const TIER_PRICE_LABELS: Record<string, string> = {
  '-': 'цена', bronze: 'бронза', silver: 'серебро', gold: 'золото', platinum: 'платина',
};
const TIER_PRICE_ORDER = ['-', 'bronze', 'silver', 'gold', 'platinum'];

const CATEGORY_LABELS: Record<string, string> = {
  top: 'Периодические топы', crosssell: 'Кросс-селл', rare: 'Редкие',
  repeat: 'Повторные продажи', speed: 'Скорость', record: 'Рекорды',
  streak: 'Серии', hygiene: 'Гигиена воронки', milestone: 'Вехи',
};

const CRITERIA_LABELS: Record<string, string> = {
  minAmount: 'мин. сумма, ₽', minPairs: 'мин. связок', minGroups: 'мин. групп',
  minRepeats: 'мин. повторок', minDeals: 'мин. сделок/мес', days: 'дней подряд', count: 'порог, шт',
};

function ThresholdInput({ row, k, onSave }: { row: Row; k: string; onSave: (patch: Record<string, unknown>) => void }) {
  const initial = row.criteria[k];
  const [draft, setDraft] = useState(String(initial ?? ''));
  const commit = () => {
    const v = Number(draft);
    if (!Number.isFinite(v) || v < 0 || String(initial) === draft) { setDraft(String(initial ?? '')); return; }
    onSave({ criteria: { ...row.criteria, [k]: v } });
  };
  return (
    <label className="inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
      {CRITERIA_LABELS[k] ?? k}
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); }}
        className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-right text-xs tabular-nums"
      />
    </label>
  );
}

// Цена награды (2657): инпут на уровень; сохранение по blur/Enter. Меняет только
// БУДУЩИЕ начисления — прошлые транзакции леджера остаются по старой цене.
function PriceInput({ row, tier, currencyName, onSave }: {
  row: Row; tier: string; currencyName: string;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const initial = row.prices[tier];
  const [draft, setDraft] = useState(String(initial ?? ''));
  const commit = () => {
    const v = Number(draft);
    if (!Number.isInteger(v) || v < 0 || String(initial) === draft) { setDraft(String(initial ?? '')); return; }
    onSave({ prices: { [tier]: v } });
  };
  return (
    <label className="inline-flex items-center gap-1 text-xs text-[var(--color-accent)]" title={`Цена в «${currencyName}» — влияет только на будущие начисления`}>
      {TIER_PRICE_LABELS[tier] ?? tier}
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); }}
        className="w-16 rounded border border-[var(--color-accent)]/40 bg-[var(--color-bg)] px-1.5 py-0.5 text-right text-xs tabular-nums"
      />
    </label>
  );
}

export function RewardsSettingsPage() {
  const qc = useQueryClient();
  const [recomputeResult, setRecomputeResult] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ rows: Row[]; currencyName: string }>({
    queryKey: ['settings-badges'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const patch = useMutation({
    mutationFn: async ({ key, body }: { key: string; body: Record<string, unknown> }) => {
      const res = await fetch(`/api/settings/badges/${encodeURIComponent(key)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings-badges'] }),
  });

  const recompute = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/badges/recompute', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ stats: { inserted: number; updated: number; total: number; coinsAccrued: number; coinsEmitted: number; ms: number } }>;
    },
    onSuccess: (d) => {
      setRecomputeResult(`+${d.stats.inserted} новых, ${d.stats.updated} обновлено, валюта: +${d.stats.coinsAccrued} начислений на ${d.stats.coinsEmitted.toLocaleString('ru-RU')}, ${Math.round(d.stats.ms / 1000)} с`);
      void qc.invalidateQueries({ queryKey: ['settings-badges'] });
    },
    onError: (e) => setRecomputeResult(`Ошибка: ${e instanceof Error ? e.message : e}`),
  });

  const currencyName = data?.currencyName ?? 'ебаллы';
  const [currencyDraft, setCurrencyDraft] = useState<string | null>(null);
  const saveCurrency = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch('/api/settings/badges/currency', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currencyName: name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      setCurrencyDraft(null);
      // название используется во всех бейдж-эндпоинтах — сбрасываем их кэши
      void qc.invalidateQueries({ queryKey: ['settings-badges'] });
      void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
      void qc.invalidateQueries({ queryKey: ['badges-team'] });
      void qc.invalidateQueries({ queryKey: ['rating-badges'] });
    },
  });
  const commitCurrency = () => {
    const v = (currencyDraft ?? '').trim();
    if (!v || v === currencyName) { setCurrencyDraft(null); return; }
    saveCurrency.mutate(v);
  };

  const rows = data?.rows ?? [];
  const byCategory = new Map<string, Row[]>();
  for (const r of rows) {
    (byCategory.get(r.category) ?? byCategory.set(r.category, []).get(r.category)!).push(r);
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Награды</h1>
        {/* Название валюты (2657): глобальная настройка, дефолт «ебаллы». */}
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
          Название валюты
          <input
            value={currencyDraft ?? currencyName}
            onChange={e => setCurrencyDraft(e.target.value)}
            onBlur={commitCurrency}
            onKeyDown={e => { if (e.key === 'Enter') commitCurrency(); }}
            maxLength={40}
            className="w-28 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
          />
        </label>
        <button
          type="button"
          onClick={() => recompute.mutate()}
          disabled={recompute.isPending}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
        >
          <RefreshCw size={12} className={recompute.isPending ? 'animate-spin' : ''} />
          {recompute.isPending ? 'Пересчёт…' : 'Пересчитать награды'}
        </button>
        {recomputeResult && <span className="text-xs text-[var(--color-text-muted)]">{recomputeResult}</span>}
      </div>

      {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}

      {[...byCategory.entries()].map(([cat, list]) => (
        <div key={cat} className="mb-5">
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-text-muted)]">{CATEGORY_LABELS[cat] ?? cat}</h2>
          <div className="flex flex-col gap-1.5">
            {list.map(r => (
              <div key={r.key} className={`flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-border)] px-3 py-2 ${r.enabled ? '' : 'opacity-60'}`}>
                <span className="text-xl">{r.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{r.name}
                    {r.tiered && <span className="ml-1.5 text-[10px] font-normal uppercase text-[var(--color-text-muted)]">уровни</span>}
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">{r.description}</div>
                </div>
                <div className="flex items-center gap-3">
                  {Object.keys(r.criteria).filter(k => typeof r.criteria[k] === 'number').map(k => (
                    <ThresholdInput key={k} row={r} k={k} onSave={(body) => patch.mutate({ key: r.key, body })} />
                  ))}
                  {/* Цены валюты (2657): по уровням для tiered, одна для остальных */}
                  {TIER_PRICE_ORDER.filter(t => (r.tiered ? t !== '-' : t === '-')).map(t => (
                    <PriceInput key={t} row={r} tier={t} currencyName={currencyName}
                      onSave={(body) => patch.mutate({ key: r.key, body })} />
                  ))}
                  <span className="text-xs tabular-nums text-[var(--color-text-muted)]" title="выдач / обладателей">
                    {r.awards} / {r.holders}
                  </span>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={e => patch.mutate({ key: r.key, body: { enabled: e.target.checked } })}
                    />
                    вкл
                  </label>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
