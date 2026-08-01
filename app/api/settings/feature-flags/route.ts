import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { invalidateFeatureFlagCache } from '@/lib/featureFlags';

// Управление фиче-флагами (миграция 132, задача владельца 01.08) — только
// супер-админ. Первое применение: planyorka_enabled — включение таба «Планёрка»
// без выкатки (код и роуты остаются, флаг — выключатель на будущее).
export async function GET() {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const res = await systemDb().query<{ key: string; enabled: boolean; updated_at: string; updated_by: string | null }>(
    `SELECT key, enabled, updated_at, updated_by FROM feature_flags ORDER BY key`,
  );
  return NextResponse.json({ flags: res.rows });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const body = await req.json() as { key?: string; enabled?: boolean };
  if (!body.key || typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'key и enabled обязательны' }, { status: 400 });
  }
  await systemDb().query(
    `INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ($1,$2,now(),$3)
     ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [body.key, body.enabled, session!.login],
  );
  invalidateFeatureFlagCache(body.key);
  return NextResponse.json({ ok: true, key: body.key, enabled: body.enabled });
}
