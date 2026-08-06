'use client';
// Раздел «Награды» как КОЛЛЕКЦИЯ АЧИВОК (задача владельца 05.08): вверху счётчик
// собранного по ступеням редкости, дальше полученные (свежие сверху), в конце —
// блеклые неполученные. Секретные до получения не показываются вовсе.
// Редкость — реальная частота владения среди «играющих» (см. /api/badges/collection).
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

interface CollectionItem {
  key: string; name: string; description: string; icon: string; category: string;
  tiered: boolean; isSecret: boolean; setOf: string[];
  owned: boolean; count: number; ownersPct: number; rarity: Rarity; lastAwardedAt: string | null;
}
interface CollectionResponse {
  items: CollectionItem[];
  totals: Record<Rarity, { owned: number; total: number }>;
  ownedCount: number; totalCount: number; players: number;
}

const RARITY: Record<Rarity, { label: string; color: string }> = {
  common: { label: 'Обычные', color: '#9ca3af' },
  uncommon: { label: 'Необычные', color: '#2f9e44' },
  rare: { label: 'Редкие', color: '#1c7ed6' },
  epic: { label: 'Эпические', color: '#9c36b5' },
  legendary: { label: 'Легендарные', color: '#e8590c' },
};
const RARITY_ORDER: Rarity[] = ['legendary', 'epic', 'rare', 'uncommon', 'common'];

function AchievementCard({ item }: { item: CollectionItem }) {
  const r = RARITY[item.rarity];
  return (
    <div
      className={`flex gap-3 rounded-xl border px-3.5 py-3 min-w-0 ${item.owned ? '' : 'opacity-45 saturate-50'}`}
      style={{ borderColor: item.owned ? `${r.color}66` : 'var(--color-border)' }}
      title={item.owned ? undefined : 'Ещё не получена'}
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--color-bg)] text-2xl">
        {item.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="text-sm font-bold text-[var(--color-text)]">{item.name}</span>
          {item.count > 1 && <span className="text-[11px] font-bold text-[var(--color-accent)]">×{item.count}</span>}
          {item.isSecret && <span className="text-[11px]" title="Секретная ачивка">🤫</span>}
        </div>
        {/* Без обрезки — см. BadgeCard: 161 символ максимум по боевому каталогу,
            min-h под 4 строки держит ровную высоту карточек в ряду. */}
        <div className="text-[12px] text-[var(--color-text-muted)] min-h-[4.2em]">{item.description}</div>
        <div className="mt-1 flex items-center gap-2 flex-wrap">
          <span
            className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
            style={{ color: r.color, backgroundColor: `${r.color}1a` }}
          >
            {r.label.replace(/ые$/, 'ая')}
          </span>
          <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums">
            есть у {item.ownersPct}% коллег
          </span>
        </div>
      </div>
    </div>
  );
}

export function AchievementsPage({ managerId, isSelf }: { managerId: string; isSelf: boolean }) {
  const [showLocked, setShowLocked] = useState(true);

  const { data, isLoading } = useQuery({
    queryKey: ['badges-collection', isSelf ? 'me' : managerId],
    queryFn: async () => {
      const qs = isSelf ? '' : `?bitrixId=${encodeURIComponent(managerId)}`;
      const res = await fetch(`/api/badges/collection${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<CollectionResponse>;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { owned, locked } = useMemo(() => {
    const items = data?.items ?? [];
    const rank = (i: CollectionItem) => RARITY_ORDER.indexOf(i.rarity);
    return {
      owned: items.filter(i => i.owned).sort((a, b) => rank(a) - rank(b) || b.count - a.count),
      locked: items.filter(i => !i.owned).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, 'ru')),
    };
  }, [data]);

  if (isLoading) return <div className="text-sm text-[var(--color-text-muted)]">Загрузка коллекции…</div>;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* ══ Счётчик коллекции ══ */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <h2 className="text-base font-bold text-[var(--color-text)]">🏅 Коллекция</h2>
          <span className="text-sm font-bold tabular-nums text-[var(--color-accent)]">
            {data?.ownedCount ?? 0} из {data?.totalCount ?? 0}
          </span>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            редкость — доля коллег, у которых награда есть (считаем по {data?.players ?? 0} участникам)
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {RARITY_ORDER.map(key => {
            const t = data?.totals[key] ?? { owned: 0, total: 0 };
            const r = RARITY[key];
            const pct = t.total > 0 ? Math.round((t.owned / t.total) * 100) : 0;
            return (
              <div key={key} className="rounded-xl border px-3 py-2.5" style={{ borderColor: `${r.color}55` }}>
                <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: r.color }}>{r.label}</div>
                <div className="text-lg font-extrabold tabular-nums text-[var(--color-text)]">
                  {t.owned}<span className="text-[13px] font-semibold text-[var(--color-text-muted)]"> / {t.total}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-[var(--color-bg-hover)]">
                  <div className="h-1.5 rounded-full" style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: r.color }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ══ Полученные ══ */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
          Получено · {owned.length}
        </div>
        {owned.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">
            {isSelf ? 'Пока пусто — награды появляются за продажи, отгрузки, допродажи и серии. Всё впереди!' : 'Наград пока нет.'}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {owned.map(i => <AchievementCard key={i.key} item={i} />)}
          </div>
        )}
      </section>

      {/* ══ Неполученные (блеклые) ══ */}
      {locked.length > 0 && (
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
          <button
            type="button"
            onClick={() => setShowLocked(v => !v)}
            className="mb-3 flex min-h-11 w-full items-center gap-2 text-left"
          >
            <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
              Ещё не получено · {locked.length}
            </span>
            <span className="text-[11px] text-[var(--color-accent)]">{showLocked ? 'свернуть' : 'показать'}</span>
          </button>
          {showLocked && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {locked.map(i => <AchievementCard key={i.key} item={i} />)}
            </div>
          )}
          <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">
            Секретные ачивки здесь не показаны — они появляются только после получения 🤫
          </p>
        </section>
      )}
    </div>
  );
}
