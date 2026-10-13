import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseModules } from '@/lib/auth/modulesAccess';
import { runClientModuleSync } from '@/lib/jobs/clientModuleSync';

// Ручной запуск сверки Битрикс → sa (та же, что ночью в 03:xx МСК).
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canUseModules(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    return NextResponse.json({ ok: true, result: await runClientModuleSync() });
  } catch (e) {
    console.error('[modules/client-card/sync]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Сверка не удалась' }, { status: 500 });
  }
}
