import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { runHealthChecks } from '@/lib/jobs/healthCheck';

// Ручной прогон сторожа систем — чтобы не ждать утра и видеть тот же список,
// что уходит в «Аналитика» (ТЗ владельца 28.09).
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;
  const checks = await runHealthChecks();
  return NextResponse.json({
    ok: checks.every(c => c.ok),
    failed: checks.filter(c => !c.ok).length,
    checks,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
