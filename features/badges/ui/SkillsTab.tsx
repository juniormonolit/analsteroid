'use client';

// Дерево скиллов в ЛК (задача 50). Движок — features/badges/engine/skills.ts.
//
// Что экран обязан объяснять без чтения документации:
//   1. «уровень нельзя купить, не наработав» — поэтому под каждой веткой видно
//      И сколько наград набрано, И сколько стоит следующий уровень, и почему
//      кнопка не нажимается именно сейчас;
//   2. «пороги открывают новые ступени награды» — лесенка из пяти ступеней с
//      порогом и ценой каждой, открытые отличаются от закрытых;
//   3. «прокачка не снижает доход» — рядом со ступенью видно её цену, и она
//      растёт вместе с порогом. Человек должен видеть это сам, а не верить.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, TrendingUp } from 'lucide-react';
import { PinDialog } from '@/components/ui/PinDialog';
import { PinSetupDialog } from '@/components/ui/PinSetupDialog';
import { fetchPinGated } from '@/lib/client/pinFetch';
import { MltCoin } from '@/components/icons/MltCoin';

interface StepView {
  step: number; unlockLevel: number; threshold: Record<string, number>;
  price: number; unlocked: boolean;
}
interface BranchView {
  branchKey: string; name: string; emoji: string; description: string | null;
  level: number; progress: number;
  nextLevel: number | null; nextPrice: number | null; nextProgressNeeded: number | null;
  canBuy: boolean; blockedBy: 'max' | 'progress' | 'balance' | null;
  steps: StepView[];
}
interface Payload {
  branches: BranchView[]; balance: number;
  multipliers: { xp: number; mlt: number; thresholds: number };
  bitrixId: number; isSelf: boolean;
}

// Порог ступени приходит как {"minRepeats": 8} — ключ у каждой ветки свой.
// Человеческая подпись важнее общности: «8 возвратов» понятнее, чем «minRepeats: 8».
const THRESHOLD_LABELS: Record<string, (v: number) => string> = {
  minRepeats: v => `${v} покупок одного клиента`,
  minCount: v => `${v} первичных за неделю`,
  minAmount: v => `${(v / 1_000_000).toFixed(1).replace('.0', '')} млн ₽ за месяц`,
  minPpp: v => `ППП ${v} за месяц`,
  minConv: v => `конверсия ${v} %`,
  minDeals: v => `${v} сделок быстрее медианы`,
  minPairs: v => `${v} пар кросс-селла`,
  minStreakWeeks: v => v === 1 ? 'неделя дисциплины' : `${v} недель подряд`,
  minKeyClients: v => `${v} ключевых клиентов`,
  count: v => `${v} квестов подряд`,
};
function thresholdText(t: Record<string, number>): string {
  const [k, v] = Object.entries(t ?? {})[0] ?? [];
  if (k === undefined) return '—';
  return (THRESHOLD_LABELS[k] ?? ((x: number) => `${k}: ${x}`))(Number(v));
}

const BLOCK_HINT: Record<NonNullable<BranchView['blockedBy']>, string> = {
  max: 'Ветка прокачана до конца',
  progress: 'Сначала заработайте награды этой ветки',
  balance: 'Не хватает MLT',
};

export function SkillsTab({ managerId, isSelf }: { managerId: string; isSelf: boolean }) {
  const qc = useQueryClient();
  const key = ['skills', managerId];
  const { data, isLoading } = useQuery<Payload>({
    queryKey: key,
    queryFn: async () => {
      const res = await fetch(`/api/skills?bitrixId=${encodeURIComponent(managerId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [pinVerifyKey, setPinVerifyKey] = useState<string | null>(null);
  const [pinSetupKey, setPinSetupKey] = useState<string | null>(null);

  const buy = useMutation({
    mutationFn: async (branchKey: string) => {
      setError(null);
      const r = await fetchPinGated('/api/skills', 'POST', { branchKey });
      if (r.needsPinSetup) { setPinSetupKey(branchKey); return; }
      if (r.needsPinVerify) { setPinVerifyKey(branchKey); return; }
      if (!r.ok) throw new Error(r.error ?? 'Ошибка');
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => setError(e instanceof Error ? e.message : 'Ошибка'),
  });

  if (isLoading) return null;
  if (!data || data.branches.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[1360px] p-4 text-sm text-[var(--color-text-muted)]">
        Дерево скиллов ещё не включено.
      </div>
    );
  }
  const m = data.multipliers;

  return (
    <div className="mx-auto w-full max-w-[1360px]">
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
        <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-base font-bold text-[var(--color-text)]">🌳 Прокачка</h2>
          <span className="text-xs text-[var(--color-text-muted)]">
            уровень качается работой и оплачивается MLT — купить ненаработанное нельзя
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
          <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]">
            Пройдено порогов: <b className="tabular-nums text-[var(--color-text)]">{m.thresholds}</b>
          </span>
          <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]">
            <TrendingUp size={13} /> XP <b className="tabular-nums text-[var(--color-text)]">×{m.xp.toFixed(2)}</b>
          </span>
          <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]">
            <MltCoin size={13} /> MLT <b className="tabular-nums text-[var(--color-text)]">×{m.mlt.toFixed(2)}</b>
          </span>
          {isSelf && (
            <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]">
              Баланс: <b className="tabular-nums text-[var(--color-text)]">{data.balance.toLocaleString('ru-RU')}</b> MLT
            </span>
          )}
        </div>
        {error && <div className="mt-2 text-xs text-[var(--color-negative,#e03131)]">{error}</div>}
      </section>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data.branches.map(b => (
          <BranchCard
            key={b.branchKey} b={b} isSelf={isSelf}
            busy={buy.isPending && buy.variables === b.branchKey}
            onBuy={() => buy.mutate(b.branchKey)}
          />
        ))}
      </div>

      <PinSetupDialog
        open={!!pinSetupKey}
        onOpenChange={(o) => { if (!o) setPinSetupKey(null); }}
        onSuccess={() => { const k = pinSetupKey; setPinSetupKey(null); if (k) buy.mutate(k); }}
      />
      <PinDialog
        open={!!pinVerifyKey}
        onOpenChange={(o) => { if (!o) setPinVerifyKey(null); }}
        title="Подтвердите прокачку пином"
        onConfirm={async (pin) => {
          if (!pinVerifyKey) return { ok: false, error: 'Нет операции' };
          const r = await fetchPinGated('/api/skills', 'POST', { branchKey: pinVerifyKey, pin });
          if (!r.ok) return { ok: false, error: r.error ?? 'Ошибка' };
          setPinVerifyKey(null);
          setError(null);
          void qc.invalidateQueries({ queryKey: key });
          return { ok: true };
        }}
      />
    </div>
  );
}

function BranchCard({ b, isSelf, busy, onBuy }: {
  b: BranchView; isSelf: boolean; busy: boolean; onBuy: () => void;
}) {
  // Прогресс до следующего уровня — по наградам ветки, а не по деньгам:
  // деньги можно накопить, награды надо заработать, и именно они здесь стена.
  const need = b.nextProgressNeeded ?? 0;
  const pct = need > 0 ? Math.min(100, Math.round((b.progress / need) * 100)) : 100;
  const nextUnlock = b.steps.find(s => !s.unlocked);

  return (
    <section className="flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
      <div className="flex items-start gap-2">
        <span className="text-2xl leading-none select-none" aria-hidden>{b.emoji}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate text-sm font-bold text-[var(--color-text)]">{b.name}</h3>
            <span className="ml-auto shrink-0 rounded-md bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px] font-bold tabular-nums">
              ур. {b.level}
            </span>
          </div>
          {b.description && (
            <p className="mt-0.5 text-[11px] leading-snug text-[var(--color-text-muted)]">{b.description}</p>
          )}
        </div>
      </div>

      {/* Полоса до следующего уровня */}
      <div className="mt-2">
        <div className="flex items-baseline justify-between text-[11px] text-[var(--color-text-muted)]">
          <span>Наград ветки: <b className="tabular-nums text-[var(--color-text)]">{b.progress}</b>{need > 0 && ` / ${need}`}</span>
          {nextUnlock && <span>след. ступень — ур. {nextUnlock.unlockLevel}</span>}
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg)]">
          <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Лесенка ступеней: видно и порог, и цену — рост цены и есть обещание
          «прокачка не снизит доход», его надо показывать, а не декларировать. */}
      <ul className="mt-2 flex flex-col gap-0.5">
        {b.steps.map(s => (
          <li
            key={s.step}
            className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] ${
              s.unlocked ? 'bg-[var(--color-bg)] text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
            }`}
          >
            {s.unlocked
              ? <span className="w-3 shrink-0 text-center" aria-hidden>✓</span>
              : <Lock size={10} className="w-3 shrink-0" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{thresholdText(s.threshold)}</span>
            <span className="shrink-0 tabular-nums opacity-80">{s.price} MLT</span>
          </li>
        ))}
      </ul>

      <div className="mt-2 flex items-center gap-2">
        {isSelf && b.nextLevel !== null ? (
          <>
            <button
              type="button" onClick={onBuy} disabled={!b.canBuy || busy}
              className="min-h-11 flex-1 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-9"
            >
              {busy ? 'Покупаю…' : `Уровень ${b.nextLevel} — ${b.nextPrice} MLT`}
            </button>
          </>
        ) : (
          <span className="text-[11px] text-[var(--color-text-muted)]">
            {b.nextLevel === null ? 'Прокачана до конца' : 'Чужая ветка — только просмотр'}
          </span>
        )}
      </div>
      {isSelf && b.blockedBy && b.blockedBy !== 'max' && (
        <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{BLOCK_HINT[b.blockedBy]}</div>
      )}
    </section>
  );
}
