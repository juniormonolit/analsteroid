// Общее для роутов app/api/tasker/*: сессия + право + срез данных.
import { getSession, type SessionUser } from '@/lib/auth/session';
import { permError, type PermKey } from '@/lib/auth/perms';
import { getSessionScope, type SessionScope } from '@/lib/org/sessionScope';

export async function taskerAuth(key: PermKey = 'section.tasker'): Promise<{ session: SessionUser; scope: SessionScope } | Response> {
  const session = await getSession();
  const err = permError(session, key);
  if (err) return err;
  return { session: session!, scope: await getSessionScope(session!) };
}

export function intParam(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function ymdParam(v: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
