import { NextRequest, NextResponse } from 'next/server';
import { managerHistory } from '@/features/tasker/trainings/engine/reports';
import { NO_STORE, withTrainingActor } from '../_shared';

// История обучений менеджера: на что, зачем, кто отправил, был ли, что изменилось (+ журнал записей/отписок).
// ?managerId= (по умолчанию — свой bitrix id). Видимость — срез сессии; тренер/админ — все.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withTrainingActor('history', async actor => {
    const raw = req.nextUrl.searchParams.get('managerId') ?? actor.session.bitrixUserId ?? '';
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return NextResponse.json({ error: 'Не указан менеджер', code: 'bad_request' }, { status: 400 });
    return NextResponse.json(await managerHistory(actor, String(n)), { headers: NO_STORE });
  });
}
