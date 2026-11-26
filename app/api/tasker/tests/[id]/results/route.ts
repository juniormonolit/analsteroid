import { NextRequest, NextResponse } from 'next/server';
import { testResults } from '@/features/tasker/tests/engine';
import { badId, NO_STORE, parseId, withTestActor } from '../../_shared';

// Результаты теста: тренер — все, РОП — свои менеджеры.
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = parseId((await ctx.params).id);
  if (!id) return badId();
  return withTestActor('results', async actor => NextResponse.json(await testResults(actor, id), { headers: NO_STORE }));
}
