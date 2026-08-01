import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { buildManagerPlanyorka, type PlanyorkaUnit } from '@/features/planyorka/engine/planyorka';

// «Планёрка» (задача владельца 01.08): текстовая сводка менеджера. Доступ — тот же
// рубеж canViewManager, что у «Моих заказчиков»/карточки менеджера: себя — всегда,
// РОП/руководство — подчинённых, остальным — 403.
const UNITS: PlanyorkaUnit[] = ['day', 'week', 'month'];

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const requested = sp.get('bitrixId');
  const bitrixId = requested && /^\d+$/.test(requested) ? requested : session.bitrixUserId;
  if (!bitrixId) return NextResponse.json({ error: 'Нет привязки к менеджеру Битрикса' }, { status: 400 });
  if (bitrixId !== session.bitrixUserId && !(await canViewManager(session, bitrixId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const unit = UNITS.find(u => u === sp.get('unit')) ?? 'month';
  const offset = Math.max(-11, Math.min(0, Number(sp.get('offset')) || 0)); // не глубже 11 периодов назад

  try {
    const result = await buildManagerPlanyorka(Number(bitrixId), unit, offset);
    return NextResponse.json(result);
  } catch (e) {
    console.error('[planyorka]', e);
    return NextResponse.json({ error: 'Не удалось построить планёрку' }, { status: 500 });
  }
}
