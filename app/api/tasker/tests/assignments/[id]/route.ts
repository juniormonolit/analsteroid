import { NextRequest, NextResponse } from 'next/server';
import { allowRetake, cancelAssignment } from '@/features/tasker/tests/engine';
import { badId, parseId, withTestActor } from '../../_shared';

// POST { action: 'retake', dueDays? } — разрешить пересдачу (тренер); DELETE — снять назначение (тренер / РОП своему).
export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return badId();
  return withTestActor('retake', async actor => {
    const b = (await req.json().catch(() => null)) as { action?: string; dueDays?: unknown } | null;
    if (b?.action !== 'retake') return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
    await allowRetake(actor, id, b.dueDays);
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return badId();
  return withTestActor('cancel', async actor => { await cancelAssignment(actor, id); return NextResponse.json({ ok: true }); });
}
