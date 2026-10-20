import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { buildDailySnapshot } from '@/features/repeat-kanban/engine/snapshot';

// Ручной запуск ежедневного снимка канбана повторных (суперадмин): первый снимок сразу после
// выкатки и перезапись дня после правок. Плановый — джоба repeatKanbanSnapshot в 23:30 МСК.
export const dynamic = 'force-dynamic';
export const maxDuration = 900;

export async function POST() {
  const session = await getSession();
  if (!session?.isSuperadmin) return NextResponse.json({ error: 'Только суперадмин' }, { status: 403 });
  const r = await buildDailySnapshot();
  return NextResponse.json(r);
}
