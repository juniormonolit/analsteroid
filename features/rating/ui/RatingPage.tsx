'use client';
// Раздел «Рейтинг» (задача владельца 30.07) — таблица рейтинга менеджеров за
// период: место, имя, отдел, итоговый балл и баллы по каждой оси шаблона карточки.
// Цифры считает тот же движок, что и ЛК менеджера (ratings.ts) — расхождений быть
// не может. Клик по строке ведёт в ЛК этого менеджера на том же периоде.
import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import Link from 'next/link';
import { BadgeCard } from '@/features/badges/ui/BadgeShelf';
import type { ShelfItem } from '@/features/badges/engine/shelf';
import { MainPeriodControl } from '@/features/reports/ui/FilterBar';
import { Seg } from '@/features/reports/ui/FiltersMenu';
import { startOfMonth } from 'date-fns';
import type { DateRange } from '@/lib/period';
import type { CardSegment } from '@/features/manager-card/engine/managerCard';

interface AxisScore { key: string; label: string; score: number | null; raw: number | null; weight: number }
interface RatingRow {
  managerId: string; name: string; login: string | null;
  department: string | null; branch: string | null;
  rating: number | null; rank: number | null; isSelf: boolean;
  axes: AxisScore[];
}
interface RatingResponse {
  rows: RatingRow[];
  total: number;
  poolSize: number;
  axes: { key: string; label: string; weight: number; invert: boolean }[];
  scopeLimited: boolean;
}

// Цвет балла: 0-10 — от отрицательного к положительному, нейтральная середина.
function scoreColor(score: number | null): string | undefined {
  if (score === null) return undefined;
  if (score >= 7) return 'var(--color-positive, #2f9e44)';
  if (score <= 3) return 'var(--color-negative, #e03131)';
  return 'var(--color-text-muted)';
}

// Сортировка по колонкам (задача Серёги 31.07): клик по заголовку числовой
// колонки — убывание, повторный клик — реверс, третий — возврат к дефолтному
// порядку по рангу. Сортировка чисто клиентская (все строки уже на клиенте).
// Колонка «#» показывает ИСХОДНЫЙ ранг менеджера (r.rank из API) и при
// пересортировке НЕ пересчитывается — видно «5-й по рейтингу, но 1-й по ебаллам».
type SortKey = 'badges' | 'coins' | 'level' | 'rating' | `axis:${string}`;
type SortState = { key: SortKey; dir: 'desc' | 'asc' } | null;

function SortableTh({ label, sortKey, sort, onSort, strong, title, left }: {
  label: string; sortKey: SortKey; sort: SortState;
  onSort: (key: SortKey) => void; strong?: boolean; title?: string; left?: boolean;
}) {
  const active = sort?.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      title={title ?? 'Сортировать по колонке'}
      className={`px-3 py-2.5 ${left ? 'text-left' : 'text-right'} font-medium whitespace-nowrap cursor-pointer select-none hover:text-[var(--color-text)] ${active || strong ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}
    >
      {label}
      <span className="inline-block w-3 text-[10px]">{active ? (sort!.dir === 'desc' ? '▼' : '▲') : ''}</span>
    </th>
  );
}

function MedalOrRank({ rank }: { rank: number | null }) {
  if (rank === null) return <span className="text-[var(--color-text-muted)]">—</span>;
  if (rank <= 3) {
    const bg = rank === 1 ? '#f59e0b' : rank === 2 ? '#94a3b8' : '#b45309';
    return (
      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full text-[12px] font-extrabold text-white" style={{ backgroundColor: bg }}>
        {rank}
      </span>
    );
  }
  return <span className="inline-block w-7 text-center text-[13px] font-semibold tabular-nums text-[var(--color-text-muted)]">{rank}</span>;
}

export function RatingPage() {
  const router = useRouter();
  const [period, setPeriod] = useState<DateRange>(() => ({ from: startOfMonth(new Date()), to: new Date() }));
  const [segment, setSegment] = useState<CardSegment>('all');

  const fromIso = period.from.toISOString();
  const toIso = period.to.toISOString();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['rating', fromIso, toIso, segment],
    queryFn: async () => {
      const res = await fetch('/api/rating', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: { from: fromIso, to: toIso }, segment }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Ошибка рейтинга');
      return res.json() as Promise<RatingResponse>;
    },
    staleTime: 60_000,
  });

  const rows = data?.rows ?? [];
  const axes = data?.axes ?? [];

  // Награды в рейтинге (доп. Серёги 31.07 к 2655): подгружаются ОТДЕЛЬНЫМ батчем
  // по списку видимых менеджеров (один POST /api/badges/batch) — запрос самого
  // рейтинга не утяжеляется. Чипы — компакт как в «Моей команде» (эмодзи топ-
  // бейджей + счётчик); клик по ячейке разворачивает полную полку BadgeCard
  // доп. строкой под менеджером (клик по остальной строке по-прежнему ведёт в ЛК).
  const badgeIdsKey = useMemo(
    () => rows.map(r => r.managerId).filter(id => /^\d+$/.test(id)).sort().join(','),
    [rows]
  );
  const { data: badgesData } = useQuery({
    queryKey: ['rating-badges', badgeIdsKey],
    queryFn: async () => {
      const res = await fetch('/api/badges/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bitrixIds: badgeIdsKey.split(',').map(Number) }),
      });
      if (!res.ok) throw new Error('Ошибка загрузки наград');
      return res.json() as Promise<{
        shelves: Record<string, ShelfItem[]>; balances: Record<string, number>; currencyName: string;
        // XP (миграция 124): уровень/титул/топ-класс — колонка «Уровень».
        xp: Record<string, { level: number; title: string; totalXp: number; topClass: { name: string; level: number } | null }>;
      }>;
    },
    enabled: badgeIdsKey.length > 0,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const shelves = badgesData?.shelves ?? {};
  // Валюта (задача 2657): баланс колонкой. С 31.07 (правка Серёги) колонка,
  // как и остальные числовые, сортируемая — см. sortedRows ниже.
  const balances = badgesData?.balances ?? {};
  const currencyName = badgesData?.currencyName ?? 'ебаллы';
  const xpMap = badgesData?.xp ?? {};
  const [openBadgesId, setOpenBadgesId] = useState<string | null>(null);

  // Состояние сортировки: null = дефолтный порядок по рангу (как отдал API).
  const [sort, setSort] = useState<SortState>(null);
  const handleSort = (key: SortKey) => {
    setSort(prev => {
      if (prev?.key !== key) return { key, dir: 'desc' };
      if (prev.dir === 'desc') return { key, dir: 'asc' };
      return null; // третий клик — возврат к дефолту
    });
  };

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const val = (r: RatingRow): number | null => {
      if (sort.key === 'coins') return balances[r.managerId] ?? 0;
      if (sort.key === 'badges') return (shelves[r.managerId] ?? []).reduce((s, it) => s + it.count, 0);
      if (sort.key === 'rating') return r.rating;
      if (sort.key === 'level') return xpMap[r.managerId]?.level ?? null;
      const axisKey = sort.key.slice('axis:'.length);
      return r.axes.find(x => x.key === axisKey)?.score ?? null;
    };
    const mult = sort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va === null && vb === null) return (a.rank ?? Infinity) - (b.rank ?? Infinity);
      if (va === null) return 1; // пустые значения всегда внизу
      if (vb === null) return -1;
      if (va !== vb) return (va - vb) * mult;
      return (a.rank ?? Infinity) - (b.rank ?? Infinity); // тай-брейк — исходный ранг
    });
  }, [rows, sort, balances, shelves, xpMap]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 sm:p-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-text)]">Рейтинг менеджеров</h1>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              Балл 0-10 по каждой оси — перцентиль среди менеджеров с продажами за период
              {data ? ` (${data.poolSize} чел.)` : ''}; итог — средневзвешенное по весам осей.
            </p>
          </div>
          <Link
            href="/settings/card-templates"
            className="tap-target inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-[var(--color-border)] rounded-lg text-[var(--color-text)] hover:border-[var(--color-border-focus)] transition-colors"
            title="Оси рейтинга и их веса"
          >
            <Settings2 size={15} />
            Настроить оси и веса
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <MainPeriodControl period={period} onPeriodChange={setPeriod} onComparisonChange={() => {}} />
          <Seg<CardSegment>
            options={['all', 'fl', 'ul']}
            value={segment}
            onChange={setSegment}
            labels={{ all: 'Все', fl: 'Физики', ul: 'Юрики' }}
          />
        </div>

        {data?.scopeLimited && (
          <div className="text-xs text-[var(--color-text-muted)]">
            Показаны менеджеры в вашей зоне ответственности. Место — из общего рейтинга ({data.total} чел.).
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-11 bg-[var(--color-border)] rounded-lg animate-pulse" />)}</div>
        ) : isError ? (
          <p className="text-sm text-[var(--color-negative)]">Не удалось посчитать рейтинг.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">Нет менеджеров с продажами за выбранный период.</p>
        ) : (
          <div className="scroll-x rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-[var(--color-table-header)]">
                  <th className="px-3 py-2.5 text-left font-medium text-[var(--color-text-muted)] whitespace-nowrap">#</th>
                  <th className="px-3 py-2.5 text-left font-medium text-[var(--color-text-muted)] whitespace-nowrap">Менеджер</th>
                  <th className="px-3 py-2.5 text-left font-medium text-[var(--color-text-muted)] whitespace-nowrap">Отдел</th>
                  <SortableTh label="Награды" sortKey="badges" sort={sort} onSort={handleSort} left />
                  <SortableTh label={currencyName} sortKey="coins" sort={sort} onSort={handleSort} />
                  <SortableTh label="Уровень" sortKey="level" sort={sort} onSort={handleSort} title="XP-уровень менеджера (репутация: только растёт) · сортировать" />
                  <SortableTh label="Рейтинг" sortKey="rating" sort={sort} onSort={handleSort} strong />
                  {axes.map(a => (
                    <SortableTh key={a.key} label={a.label} sortKey={`axis:${a.key}`} sort={sort} onSort={handleSort} title={`Вес ${a.weight} · сортировать`} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r, i) => {
                  const shelf = shelves[r.managerId] ?? [];
                  const badgesTotal = shelf.reduce((s, item) => s + item.count, 0);
                  const badgesOpen = openBadgesId === r.managerId;
                  return (
                  <React.Fragment key={r.managerId}>
                  <tr
                    onClick={() => router.push(`/manager/${r.managerId}?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&name=${encodeURIComponent(r.name)}`)}
                    className={`border-t border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-table-row-hover)] ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''} ${r.isSelf ? 'bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]' : ''}`}
                    title="Открыть ЛК менеджера"
                  >
                    <td className="px-3 py-2"><MedalOrRank rank={r.rank} /></td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="font-medium text-[var(--color-text)]">{r.name}</span>
                      {r.isSelf && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-accent)] text-[var(--color-text-inverse)]">вы</span>}
                      {r.login && <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">{r.login}</span>}
                    </td>
                    <td className="px-3 py-2 text-[var(--color-text-muted)] whitespace-nowrap">
                      {r.department ?? '—'}{r.branch ? ` · ${r.branch}` : ''}
                    </td>
                    {/* Награды: компакт-чипы (топ-эмодзи + счётчик), клик — полная
                        полка доп. строкой; stopPropagation — строка ведёт в ЛК. */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      {shelf.length > 0 ? (
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setOpenBadgesId(badgesOpen ? null : r.managerId); }}
                          className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 hover:bg-[var(--color-bg-hover)] transition-colors"
                          title={badgesOpen ? 'Свернуть награды' : 'Показать все награды'}
                        >
                          {shelf.slice(0, 4).map(item => (
                            <span key={item.key} title={item.name} className="text-base leading-none">{item.icon}</span>
                          ))}
                          <span className="text-[11px] text-[var(--color-text-muted)]">{badgesTotal}</span>
                        </button>
                      ) : (
                        <span className="text-[11px] text-[var(--color-text-muted)]">—</span>
                      )}
                    </td>
                    {/* Баланс валюты (2657) */}
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-[var(--color-accent)]">
                      {(balances[r.managerId] ?? 0) > 0 ? (balances[r.managerId] ?? 0).toLocaleString('ru-RU') : '—'}
                    </td>
                    {/* XP-уровень (миграция 124): уровень + титул, тултип — топ-класс */}
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {(() => {
                        const x = xpMap[r.managerId];
                        if (!x || x.level <= 0) return <span className="text-[11px] text-[var(--color-text-muted)]">—</span>;
                        return (
                          <span className="tabular-nums font-bold text-[var(--color-accent)]"
                            title={`${x.title} · ${x.totalXp.toLocaleString('ru-RU')} XP${x.topClass ? ` · топ-класс: ${x.topClass.name} ${x.topClass.level} ур.` : ''}`}>
                            {x.level}
                            {x.topClass && <span className="ml-1 text-[10px] font-semibold text-[var(--color-text-muted)]">{x.topClass.name}</span>}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className="text-[15px] font-extrabold tabular-nums text-[var(--color-text)]">
                        {r.rating !== null ? r.rating.toFixed(1) : '—'}
                      </span>
                    </td>
                    {axes.map(a => {
                      const s = r.axes.find(x => x.key === a.key)?.score ?? null;
                      return (
                        <td key={a.key} className="px-3 py-2 text-right tabular-nums" style={{ color: scoreColor(s) }}>
                          {s !== null ? s.toFixed(1) : '—'}
                        </td>
                      );
                    })}
                  </tr>
                  {badgesOpen && shelf.length > 0 && (
                    <tr className="border-t border-[var(--color-border)]">
                      <td colSpan={7 + axes.length} className="p-3 bg-[var(--color-bg)]">
                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                          {shelf.map(item => <BadgeCard key={item.key} item={item} />)}
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
