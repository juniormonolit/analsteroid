'use client';
// «Люди» (задача владельца 05.08, ЛК-соцсетка): поиск по всем сотрудникам компании
// и переход в публичный профиль /profile/<bitrixId>. Аналог «поиска друзей»:
// карточка человека — аватар, имя, отдел/филиал, уровень XP (батчем из
// /api/badges/batch, тем же приёмом, что рейтинг — справочник не утяжеляем).
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';

interface Person { id: string; name: string; department: string | null; branch: string | null; avatarUrl: string | null }

export function PeoplePage() {
  const [q, setQ] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['profile-people'],
    queryFn: async () => {
      const res = await fetch('/api/profile/people');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ people: Person[] }>;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const people = useMemo(() => data?.people ?? [], [data]);

  // Уровни — отдельным батчем, как в рейтинге: справочник отвечает мгновенно,
  // уровни доезжают следом.
  const idsKey = useMemo(() => people.map(p => p.id).sort().join(','), [people]);
  const { data: xpData } = useQuery({
    queryKey: ['people-xp', idsKey],
    queryFn: async () => {
      const res = await fetch('/api/badges/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bitrixIds: idsKey.split(',').map(Number) }),
      });
      if (!res.ok) throw new Error('Ошибка уровней');
      return res.json() as Promise<{ xp: Record<string, { level: number; title: string; topClass: { name: string; level: number } | null }> }>;
    },
    enabled: idsKey.length > 0,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const xpMap = xpData?.xp ?? {};

  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
  const query = norm(q.trim());
  const filtered = query
    ? people.filter(p =>
        norm(p.name).includes(query)
        || (p.department && norm(p.department).includes(query))
        || (p.branch && norm(p.branch).includes(query)))
    : people;

  return (
    <div className="mx-auto w-full max-w-[1100px] p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <h1 className="text-xl font-extrabold text-[var(--color-text)]">Люди</h1>
        {data && (
          <span className="text-[13px] text-[var(--color-text-muted)] tabular-nums">
            {filtered.length === people.length ? people.length : `${filtered.length} из ${people.length}`}
          </span>
        )}
      </div>

      <label className="relative block">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Имя, отдел или филиал…"
          // text-base на мобильном (≥16px) — иначе iOS зумит при фокусе (правило 9).
          className="w-full min-h-11 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] pl-9 pr-3 text-base sm:text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none focus:border-[var(--color-border-focus)]"
        />
      </label>

      {isLoading && <div className="text-sm text-[var(--color-text-muted)] py-8 text-center">Загрузка…</div>}
      {isError && <div className="text-sm text-[var(--color-negative)] py-8 text-center">Не удалось загрузить список сотрудников</div>}
      {!isLoading && !isError && filtered.length === 0 && (
        <div className="text-sm text-[var(--color-text-muted)] py-8 text-center">Никого не нашлось. Измените запрос</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {filtered.map(p => {
          const xp = xpMap[p.id];
          return (
            <Link
              key={p.id}
              href={`/profile/${p.id}`}
              className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3.5 py-3 min-h-11 min-w-0 transition-colors hover:bg-[var(--color-bg-hover)]"
            >
              <Avatar name={p.name} url={p.avatarUrl} size={44} shape="rounded" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[var(--color-text)] truncate">
                  {p.name}
                  {xp && xp.level > 0 && (
                    <span className="ml-1.5 align-middle text-[11px] font-bold text-[var(--color-accent)]">{xp.level} ур.</span>
                  )}
                </div>
                <div className="text-[12px] text-[var(--color-text-muted)] truncate">
                  {[p.department, p.branch].filter(Boolean).join(' · ') || '—'}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
