import { NextRequest, NextResponse } from 'next/server';
import { getTest, updateTest } from '@/features/tasker/tests/engine';
import type { TestResponse } from '@/features/tasker/tests/types';
import { badId, NO_STORE, parseId, withTestActor } from '../_shared';

// Тест целиком (с правильными ответами) — только тренеру. PATCH — правка рабочей копии / publish / archive / unarchive.
export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return badId();
  return withTestActor('GET one', async actor => NextResponse.json({ test: await getTest(actor, id) } satisfies TestResponse, { headers: NO_STORE }));
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const id = parseId((await ctx.params).id);
  if (!id) return badId();
  return withTestActor('PATCH', async actor => {
    const test = await updateTest(actor, id, await req.json().catch(() => null));
    return NextResponse.json({ test } satisfies TestResponse);
  });
}
