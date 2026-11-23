import { NextRequest, NextResponse } from 'next/server';
import { enroll, unenroll } from '@/features/tasker/trainings/engine';
import type { TrainingEventResponse } from '@/features/tasker/trainings/types';
import { parseId, withTrainingActor } from '../../_shared';

// Запись менеджера на обучение: { managerId, taskerTaskId? }. РОП/директор/админ — своих (canSeeManager),
// тренер — любого. Проверки: событие не отменено и не прошло, лимит мест (под блокировкой строки события).
// Повторная запись того же менеджера — не ошибка (форма задачи может прислать её ещё раз).
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return NextResponse.json({ error: 'Некорректный id', code: 'bad_request' }, { status: 400 });
  return withTrainingActor('enroll', async actor => {
    const b = (await req.json().catch(() => null)) as { managerId?: unknown; taskerTaskId?: unknown } | null;
    return NextResponse.json({ event: await enroll(actor, id, b?.managerId, b?.taskerTaskId) } satisfies TrainingEventResponse);
  });
}

/** Тело { managerId } или ?managerId= (некоторые клиенты не шлют тело с DELETE). */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return NextResponse.json({ error: 'Некорректный id', code: 'bad_request' }, { status: 400 });
  return withTrainingActor('unenroll', async actor => {
    const b = (await req.json().catch(() => null)) as { managerId?: unknown } | null;
    const managerId = b?.managerId ?? req.nextUrl.searchParams.get('managerId');
    return NextResponse.json({ event: await unenroll(actor, id, managerId) } satisfies TrainingEventResponse);
  });
}
