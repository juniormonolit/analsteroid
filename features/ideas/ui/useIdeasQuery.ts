'use client';
import { useQuery } from '@tanstack/react-query';
import type { IdeasListResponse } from '@/lib/ideas/types';

/** Общий query-ключ ленты «Идеи и планы» — тот же паттерн, что useChangelogQuery. */
export function useIdeasQuery() {
  return useQuery<IdeasListResponse>({
    queryKey: ['ideas'],
    queryFn: async () => {
      const res = await fetch('/api/ideas');
      if (!res.ok) throw new Error('Failed to load ideas');
      return res.json();
    },
    staleTime: 30_000,
  });
}
