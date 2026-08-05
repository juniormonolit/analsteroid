'use client';
// Публичный профиль сотрудника (задача владельца 05.08, ЛК-соцсетка): «показывает
// всё, что и так у человека в профиле, всем» — вкладка «Профиль» ЛК один-в-один
// (тот же ProfileTab, isSelf=false + forceReadOnly) плюс полный список наград
// (RewardsTab) по кнопке «Все награды». Личное («Статистика», «Квесты»,
// «Заказчики», «Инвентарь») сюда сознательно НЕ выведено.
//
// card для ProfileTab собирается из лёгкого /api/profile/public (только личность):
// полная аналитика /api/manager-card остаётся за canViewManager, публичному
// профилю она не нужна. ranks/rating в псевдо-карточке пустые — ProfileTab
// корректно прячет блок лесенки мест, когда ranks нет.
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { ProfileTab, RewardsTab } from '@/features/manager-card/ui/ManagerTabs';
import type { ManagerCardResult } from '@/features/manager-card/engine/managerCard';

interface PublicIdentity {
  profile: { name: string; department: string | null; branch: string | null; avatarUrl: string | null };
}

export function PublicProfilePage({ bitrixId }: { bitrixId: string }) {
  const [view, setView] = useState<'profile' | 'rewards'>('profile');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['public-profile', bitrixId],
    queryFn: async () => {
      const res = await fetch(`/api/profile/public?bitrixId=${encodeURIComponent(bitrixId)}`);
      if (!res.ok) throw new Error(res.status === 404 ? 'Сотрудник не найден' : `HTTP ${res.status}`);
      return res.json() as Promise<PublicIdentity>;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // ProfileTab читает из card только profile/ranks/rating (см. его код) — псевдо-
  // карточка с этими полями достаточна; каст через unknown осознанный: остальные
  // поля ManagerCardResult публичному профилю не нужны и не читаются.
  const pseudoCard = data
    ? ({
        profile: {
          name: data.profile.name,
          department: data.profile.department,
          branch: data.profile.branch,
          avatarUrl: data.profile.avatarUrl,
        },
        ranks: [],
        rating: { value: null, deptSize: null },
      } as unknown as ManagerCardResult)
    : undefined;

  if (isError) {
    return (
      <div className="p-6 text-sm text-[var(--color-text-muted)]">
        Сотрудник не найден. <Link href="/profile/people" className="text-[var(--color-accent)] hover:underline font-semibold">К списку людей</Link>
      </div>
    );
  }

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="mx-auto w-full max-w-[1360px] flex items-center gap-2 min-w-0">
        <Link
          href="/profile/people"
          className="min-h-11 inline-flex items-center gap-1.5 rounded-lg px-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors shrink-0"
        >
          <ArrowLeft size={16} /> Люди
        </Link>
        <span className="text-sm font-semibold text-[var(--color-text)] truncate">
          {isLoading ? 'Загрузка…' : data?.profile.name}
        </span>
      </div>

      {view === 'profile' ? (
        <ProfileTab
          managerId={bitrixId}
          isSelf={false}
          card={pseudoCard}
          onGoRewards={() => setView('rewards')}
          forceReadOnly
        />
      ) : (
        <div className="mx-auto w-full max-w-[1360px] flex flex-col gap-3">
          <button
            onClick={() => setView('profile')}
            className="self-start min-h-11 inline-flex items-center gap-1.5 rounded-lg px-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            <ArrowLeft size={16} /> К профилю
          </button>
          <RewardsTab managerId={bitrixId} isSelf={false} forceReadOnly />
        </div>
      )}
    </div>
  );
}
