import { NextRequest, NextResponse } from 'next/server';
import { getTestActor, managerTests } from '@/features/tasker/tests/engine';
import type { ManagerTestsResponse } from '@/features/tasker/tests/types';
import { NO_STORE, withSelf } from '../_shared';

// Тесты менеджера для карточки (блок «Задачи и обучения»): ?managerId= — сам менеджер, его РОП/директор, тренер.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withSelf('manager', async session => {
    const m = req.nextUrl.searchParams.get('managerId') ?? '';
    if (!/^\d+$/.test(m)) return NextResponse.json({ error: 'Нужен managerId' }, { status: 400 });
    const actor = await getTestActor(session);
    return NextResponse.json({ rows: await managerTests(actor, m) } satisfies ManagerTestsResponse, { headers: NO_STORE });
  });
}
