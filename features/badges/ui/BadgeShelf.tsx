'use client';

// Полка трофеев (задача 2655): бейджи с уровнями (бронза/серебро/золото/платина),
// счётчиками, прогрессом к следующему порогу и «свежие сверху». Только эмодзи и
// CSS-цвета — без внешних ассетов. + «Моя команда» для ЛК РОПа (полки подчинённых).

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { TIER_COLORS, TIER_LABELS, TIER_SCOPE_LABELS, type BadgeTier } from '@/features/badges/engine/catalog';

interface ShelfTierCount { tier: BadgeTier; count: number; lastPeriod: string | null }
interface ShelfItem {
  key: string; name: string; description: string; icon: string; category: string;
  tiered: boolean; tiers: ShelfTierCount[]; count: number; value: number | null;
  lastAwardedAt: string | null;
  progress: { current: number; target: number } | null;
}

function TierChip({ t }: { t: ShelfTierCount }) {
  const color = TIER_COLORS[t.tier];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold"
      style={{ borderColor: color, color }}
      title={`${TIER_LABELS[t.tier]} — ${TIER_SCOPE_LABELS[t.tier]}`}
    >
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {TIER_LABELS[t.tier]} ×{t.count}
    </span>
  );
}

export function BadgeCard({ item }: { item: ShelfItem }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
      <div className="flex items-start gap-2.5">
        <span className="text-2xl leading-none">{item.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-sm font-semibold text-[var(--color-text)]">{item.name}</span>
            {!item.tiered && item.value !== null && item.value > 1 && (
              <span className="text-xs font-bold text-[var(--color-accent)]">×{item.value}</span>
            )}
            {!item.tiered && item.value === null && item.count > 1 && (
              <span className="text-xs font-bold text-[var(--color-accent)]">×{item.count}</span>
            )}
          </div>
          <div className="text-xs text-[var(--color-text-muted)] line-clamp-2" title={item.description}>{item.description}</div>
        </div>
      </div>
      {item.tiered && item.tiers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {item.tiers.map(t => <TierChip key={t.tier} t={t} />)}
        </div>
      )}
      {item.progress && item.progress.target > item.progress.current && (
        <div className="mt-0.5">
          <div className="mb-0.5 flex justify-between text-[10px] text-[var(--color-text-muted)]">
            <span>до следующего уровня</span>
            <span>{item.progress.current} / {item.progress.target}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-border)]">
            <div
              className="h-full rounded-full bg-[var(--color-accent)]"
              style={{ width: `${Math.min(100, (item.progress.current / item.progress.target) * 100)}%` }}
            />
          </div>
        </div>
      )}
      {item.lastAwardedAt && (
        <div className="text-[10px] text-[var(--color-text-muted)]">
          обновлено {item.lastAwardedAt.slice(0, 10).split('-').reverse().join('.')}
        </div>
      )}
    </div>
  );
}

export function BadgeShelf({ compactIfEmpty = false }: { compactIfEmpty?: boolean }) {
  const { data, isLoading } = useQuery<{ shelf: ShelfItem[] }>({
    queryKey: ['badges-me'],
    queryFn: async () => {
      const res = await fetch('/api/badges/me');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const shelf = data?.shelf ?? [];
  if (isLoading || (shelf.length === 0 && compactIfEmpty)) return null;

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)]">🏅 Мои награды</h2>
        {shelf.length > 0 && <span className="text-xs text-[var(--color-text-muted)]">{shelf.length}</span>}
      </div>
      {shelf.length === 0 ? (
        <div className="text-sm text-[var(--color-text-muted)]">
          Пока пусто — награды появляются за продажи, отгрузки, допродажи и серии. Всё впереди!
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shelf.map(item => <BadgeCard key={item.key} item={item} />)}
        </div>
      )}
    </div>
  );
}

// ── «Моя команда» (ЛК РОПа): подчинённые с полками, компакт → разворот ────────

interface TeamMember { bitrixId: number; name: string; departmentName: string | null; shelf: ShelfItem[] }

export function TeamBadgesBlock() {
  const [openIds, setOpenIds] = useState<Set<number>>(new Set());
  const { data, isLoading } = useQuery<{ team: TeamMember[] }>({
    queryKey: ['badges-team'],
    queryFn: async () => {
      const res = await fetch('/api/badges/team');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const team = data?.team ?? [];
  if (isLoading || team.length === 0) return null;

  const toggle = (id: number) => setOpenIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)]">🏅 Моя команда — трофеи</h2>
        <span className="text-xs text-[var(--color-text-muted)]">{team.length} чел.</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {team.map(m => {
          const open = openIds.has(m.bitrixId);
          const total = m.shelf.reduce((s, i) => s + i.count, 0);
          const top = m.shelf.slice(0, 6);
          return (
            <div key={m.bitrixId} className="rounded-xl border border-[var(--color-border)]">
              <button
                type="button"
                onClick={() => toggle(m.bitrixId)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-bg-hover)]"
              >
                {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                <span className="text-sm font-semibold text-[var(--color-text)]">{m.name}</span>
                {m.departmentName && <span className="text-xs text-[var(--color-text-muted)]">{m.departmentName}</span>}
                <span className="ml-auto flex items-center gap-1.5">
                  {/* компакт: топ-бейджи эмодзи + счётчик */}
                  {top.map(i => <span key={i.key} title={i.name} className="text-base leading-none">{i.icon}</span>)}
                  <span className="text-xs text-[var(--color-text-muted)]">{total > 0 ? `${total} нагр.` : 'пока без наград'}</span>
                </span>
              </button>
              {open && m.shelf.length > 0 && (
                <div className="grid grid-cols-1 gap-2.5 border-t border-[var(--color-border)] p-3 sm:grid-cols-2 lg:grid-cols-3">
                  {m.shelf.map(item => <BadgeCard key={item.key} item={item} />)}
                </div>
              )}
              {open && m.shelf.length === 0 && (
                <div className="border-t border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]">Наград пока нет</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
