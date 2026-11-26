import { NextRequest, NextResponse } from 'next/server';
import { createTest, listTests } from '@/features/tasker/tests/engine';
import type { TestResponse, TestsListResponse } from '@/features/tasker/tests/types';
import { NO_STORE, withTestActor } from './_shared';

// Тесты Задачника: GET — список (тренер — все, РОП — опубликованные); POST — создать (тренер).
export const dynamic = 'force-dynamic';

export async function GET() {
  return withTestActor('GET', async actor => {
    const body: TestsListResponse = { tests: await listTests(actor), canManage: actor.canManage, canAssign: actor.canAssign };
    return NextResponse.json(body, { headers: NO_STORE });
  });
}

export async function POST(req: NextRequest) {
  return withTestActor('POST', async actor => {
    const test = await createTest(actor, await req.json().catch(() => null));
    return NextResponse.json({ test } satisfies TestResponse);
  });
}
