import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { getDealBatchSettings, parseBatchSettings, saveDealBatchSettings } from '@/lib/reports/dealBatchSettings';

// Настройки режима «Последние N закрытых сделок» и правил «зомби» (ТЗ владельца
// 28.09). Читает любой залогиненный — от них зависит подпись в шапке отчёта;
// меняет только супер-админ, как и остальные расчётные настройки (daily-plan-mode).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json(await getDealBatchSettings());
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;
  const parsed = parseBatchSettings(await req.json().catch(() => ({})));
  await saveDealBatchSettings(parsed, session!.id);
  return NextResponse.json(parsed);
}
