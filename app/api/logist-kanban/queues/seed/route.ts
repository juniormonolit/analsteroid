import { NextResponse } from 'next/server';
import type { SeedQueuesResponse } from '@/features/logist-kanban/engine/requests/contract';
import { NO_STORE, err, withActor } from '@/features/logist-kanban/engine/requests/http';
import { seedQueuesFromSupplyPanel } from '@/features/logist-kanban/engine/requests/queues';

// POST /api/logist-kanban/queues/seed → SeedQueuesResponse: проекты Панели снабжения → очереди (canManageLogistKanban).
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST() {
  return withActor('queues:seed', async a => {
    if (!a.canManage) return err('Посев очередей — только руководителю логистики', 403, 'forbidden');
    const r: SeedQueuesResponse = await seedQueuesFromSupplyPanel(a.login);
    return NextResponse.json(r, { headers: NO_STORE });
  }, { zone: false });
}
