import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { runChecks, CHECK_KEYS } from '@/features/diag/engine/checks';

// Фаза 0 диагностики (ТЗ №1 §12): проверки данных. Только супер-админ; долгие
// (до нескольких минут) — можно по одной: ?only=zombie,handover. Результат также
// пишется в stdout с маркером [diag-checks] — читается из app.log на проде.
export const maxDuration = 600;

export async function GET(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const only = req.nextUrl.searchParams.get('only')?.split(',').map(s => s.trim()).filter(Boolean);
  if (req.nextUrl.searchParams.get('list') === '1') return NextResponse.json({ checks: CHECK_KEYS });
  const results = await runChecks(only && only.length ? only : undefined);
  for (const r of results) {
    console.log(`[diag-checks] ${r.key} ${r.status} ${r.ms}ms :: ${r.note}`);
    console.log(`[diag-checks-rows] ${r.key} ${JSON.stringify(r.rows).slice(0, 20000)}`);
  }
  return NextResponse.json({ ranAt: new Date().toISOString(), results });
}
