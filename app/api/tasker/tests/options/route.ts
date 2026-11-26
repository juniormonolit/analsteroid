import { NextResponse } from 'next/server';
import { assignOptions } from '@/features/tasker/tests/engine';
import { withTestActor } from '../_shared';

// Кого можно назначить: менеджеры отделов продаж и отделы — в срезе пользователя.
export const dynamic = 'force-dynamic';

export async function GET() {
  return withTestActor('options', async actor => NextResponse.json(await assignOptions(actor)));
}
