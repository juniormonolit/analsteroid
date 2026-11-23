import { NextRequest, NextResponse } from 'next/server';
import { setAttendance } from '@/features/tasker/trainings/engine';
import type { TrainingEventResponse } from '@/features/tasker/trainings/types';
import { parseId, withTrainingActor } from '../../_shared';

// Посещаемость: { managerId, attended: true | false | null } — только тренер, после начала события.
// Не отмечено (null) — человек не идёт в оценку эффективности.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = parseId((await ctx.params).id);
  if (!id) return NextResponse.json({ error: 'Некорректный id', code: 'bad_request' }, { status: 400 });
  return withTrainingActor('attendance', async actor => {
    const b = (await req.json().catch(() => null)) as { managerId?: unknown; attended?: unknown } | null;
    const event = await setAttendance(actor, id, b?.managerId, b?.attended === undefined ? null : b.attended);
    return NextResponse.json({ event } satisfies TrainingEventResponse);
  });
}
