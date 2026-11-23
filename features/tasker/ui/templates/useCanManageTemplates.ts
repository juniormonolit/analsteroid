'use client';
import { useQuery } from '@tanstack/react-query';
import { hasPerm } from '@/lib/auth/perms';
import type { SessionUser } from '@/lib/auth/session';

/** Может ли пользователь править шаблоны рекомендаций — зеркало canManageTemplates (engine/templates.ts):
 *  «Администратор»/супер-админ или право action.tasker.templates. Сервер проверяет сам. */
export function canManageTemplatesClient(s: SessionUser | null | undefined): boolean {
  return !!s && (s.isSuperadmin || s.roleName === 'Администратор' || hasPerm(s, 'action.tasker.templates'));
}

export function useCanManageTemplates(): boolean {
  const { data } = useQuery<SessionUser | null>({
    queryKey: ['auth-session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session');
      if (!res.ok) return null;
      return (await res.json()).user ?? null;
    },
    staleTime: 60_000,
  });
  return canManageTemplatesClient(data);
}
