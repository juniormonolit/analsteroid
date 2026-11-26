import { NextRequest, NextResponse } from 'next/server';
import { assignTest } from '@/features/tasker/tests/engine';
import type { TestAssignResponse } from '@/features/tasker/tests/types';
import { badId, parseId, withTestActor } from '../../_shared';

// Назначить тест вручную: { managerIds?, departmentIds?, dueDays? } — тренер любым, РОП своим.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = parseId((await ctx.params).id);
  if (!id) return badId();
  return withTestActor('assign', async actor =>
    NextResponse.json((await assignTest(actor, id, await req.json().catch(() => null))) satisfies TestAssignResponse));
}
