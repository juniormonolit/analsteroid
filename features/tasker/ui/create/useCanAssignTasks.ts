'use client';
import { useQuery } from '@tanstack/react-query';
import { hasPerm } from '@/lib/auth/perms';
import type { SessionUser } from '@/lib/auth/session';

/** Есть ли у текущего пользователя право ставить задачи (action.tasker.assign).
 *  Тот же queryKey ['auth-session'], что у SalesReportPage/SaveReportModal — без второго запроса. */
export function useCanAssignTasks(): boolean {
  const { data } = useQuery<SessionUser | null>({
    queryKey: ['auth-session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session');
      if (!res.ok) return null;
      const body = await res.json();
      return body.user ?? null;
    },
    staleTime: 60_000,
  });
  return hasPerm(data ?? null, 'action.tasker.assign');
}
