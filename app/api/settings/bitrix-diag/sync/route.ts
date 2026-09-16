import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { syncB24Diag } from '@/lib/b24diag/sync';

export const maxDuration = 300;
// Ручной синк из настроек (force — даже если синхронизация выключена).
export async function POST() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  return NextResponse.json(await syncB24Diag({ force: true, limit: 200 }));
}
