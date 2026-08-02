'use client';

// Настройки квестов (миграция 125): номиналы (база = синий тир), множители
// тиров, цены реролла/докупа, XP-множитель. Секция «Настройки → Награды».

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

type Tier = 'white' | 'green' | 'blue' | 'epic' | 'legendary';
const TIER_LABELS: Record<Tier, string> = {
  white: 'Обычный', green: 'Необычный', blue: 'Редкий', epic: 'Эпический', legendary: 'Легендарный',
};

interface Payload {
  settings: {
    rewardDay: number; rewardWeek: number; rewardMonth: number;
    tierMult: Record<Tier, number>; xpMult: number;
    rerollDay: number; rerollWeek: number; rerollMonth: number; extraDay: number;
  };
}

const FIELDS: [string, string][] = [
  ['rewardDay', 'Дневной (синий тир)'], ['rewardWeek', 'Недельный (синий тир)'], ['rewardMonth', 'Месячный (синий тир)'],
  ['xpMult', 'XP за 1 MLT награды'],
  ['rerollDay', 'Замена дневного'], ['rerollWeek', 'Замена недельного'], ['rerollMonth', 'Замена месячного'],
  ['extraDay', 'Доп. дневной (база, ×2 за каждый следующий)'],
];

export function QuestSettingsBlock() {
  const qc = useQueryClient();
  const { data } = useQuery<Payload>({
    queryKey: ['settings-quests'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges/quests');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });
  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch('/api/settings/badges/quests', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings-quests'] }),
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (!data) return null;
  const s = data.settings;

  const save = (key: string) => {
    const raw = drafts[key];
    if (raw === undefined || raw.trim() === '') return;
    const v = Number(raw.replace(',', '.'));
    if (!Number.isFinite(v)) return;
    if (key.startsWith('tier:')) {
      const t = key.slice(5) as Tier;
      patch.mutate({ tierMult: { ...s.tierMult, [t]: v } });
    } else patch.mutate({ [key]: v });
    setDrafts(d => { const n = { ...d }; delete n[key]; return n; });
  };
  const input = (key: string, value: number) => (
    <input
      className="w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-right tabular-nums"
      value={drafts[key] ?? String(value)}
      onChange={e => setDrafts(d => ({ ...d, [key]: e.target.value }))}
      onBlur={() => save(key)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );

  return (
    <section className="mt-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)]">🗺️ Квесты</h2>
        <span className="text-xs text-[var(--color-text-muted)]">номиналы наград, множители тиров, цены реролла</span>
      </div>
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map(([key, label]) => (
          <label key={key} className="flex items-center justify-between gap-2 text-[13px]">
            <span className="text-[var(--color-text)]">{label}</span>
            {input(key, (s as unknown as Record<string, number>)[key])}
          </label>
        ))}
      </div>
      <div className="mt-3 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Множители тиров</div>
      <div className="mt-1 grid gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
        {(Object.keys(TIER_LABELS) as Tier[]).map(t => (
          <label key={t} className="flex items-center justify-between gap-2 text-[13px]">
            <span className="text-[var(--color-text)]">{TIER_LABELS[t]}</span>
            {input(`tier:${t}`, s.tierMult[t])}
          </label>
        ))}
      </div>
      {patch.isError && (
        <div className="mt-2 text-xs text-[var(--color-negative,#e03131)]">
          {patch.error instanceof Error ? patch.error.message : 'Ошибка сохранения'}
        </div>
      )}
    </section>
  );
}
