'use client';
import { useQuery } from '@tanstack/react-query';
import type { ChangelogListResponse } from '@/lib/changelog/types';

/**
 * Общий query-ключ для бейджа в сайдбаре и панели «Что изменилось?» — один и тот
 * же кэш react-query, так что POST seen из панели (см. ChangelogPanel.markAllRead)
 * гасит бейдж мгновенно во всех местах, где смонтирован этот хук (десктопный
 * сайдбар + мобильный drawer одновременно).
 */
export function useChangelogQuery() {
  return useQuery<ChangelogListResponse>({
    queryKey: ['changelog'],
    queryFn: async () => {
      const res = await fetch('/api/changelog');
      if (!res.ok) throw new Error('Failed to load changelog');
      return res.json();
    },
    staleTime: 30_000,
  });
}
