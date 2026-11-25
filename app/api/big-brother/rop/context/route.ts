import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewRopRating } from '@/features/big-brother/engine/rop/access';
import { parsePeriod } from '@/features/big-brother/engine/rop/period';
import { buildRopContext } from '@/features/big-brother/engine/rop/context';

// «Большой брат» → «РОПы», контекст (не баллы): «отчёт → задача», внимание к подчинённым, ритм.
// GET ?from&to&blind=N (недель без просмотра для «слепой зоны», 1–12, по умолчанию 2) → RopContextResponse. Только админы.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewRopRating(session)) return NextResponse.json({ error: 'Рейтинг РОПов — только администраторам' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const b = Number(sp.get('blind'));
  try {
    const data = await buildRopContext(parsePeriod(sp.get('from'), sp.get('to')), Number.isInteger(b) && b >= 1 && b <= 12 ? b : 2);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[big-brother rop context]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка расчёта' }, { status: 500 });
  }
}
