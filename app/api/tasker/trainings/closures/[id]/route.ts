import { NextResponse } from 'next/server';
import { deleteClosure } from '@/features/tasker/trainings/engine/closures';
import { parseId, withTrainingActor } from '../../_shared';

// Открыть запись обратно (удалить закрытие). Только тренер.
export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTrainingActor('closures DELETE', async actor => {
    const id = parseId((await ctx.params).id);
    if (!id) return NextResponse.json({ error: 'Некорректный id' }, { status: 400 });
    await deleteClosure(actor, id);
    return NextResponse.json({ ok: true });
  });
}
