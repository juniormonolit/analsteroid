import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { runChecks, lastCheckResults, CHECK_KEYS } from '@/features/diag/engine/checks';

// Фаза 0 диагностики (ТЗ №1 §12): проверки данных. Только супер-админ; долгие
// (до нескольких минут) — можно по одной: ?only=zombie,handover. Результаты сохраняются в
// system.diag_check_runs (миграция 206) — исполнитель читает их оттуда; ?last=1 — последние.
export const maxDuration = 600;

export async function GET(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const only = req.nextUrl.searchParams.get('only')?.split(',').map(s => s.trim()).filter(Boolean);
  if (req.nextUrl.searchParams.get('list') === '1') return NextResponse.json({ checks: CHECK_KEYS });
  if (req.nextUrl.searchParams.get('last') === '1') return NextResponse.json({ results: await lastCheckResults() });
  const results = await runChecks(only && only.length ? only : undefined, session!.login);
  return NextResponse.json({ ranAt: new Date().toISOString(), results });
}
