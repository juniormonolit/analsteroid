import { NextRequest, NextResponse } from 'next/server';
import type { QueuesResponse } from '@/features/logist-kanban/engine/requests/contract';
import { NO_STORE, err, jsonBody, withActor } from '@/features/logist-kanban/engine/requests/http';
import { parseQueueBody, loadQueues, upsertQueue } from '@/features/logist-kanban/engine/requests/queues';
import { loadSettings } from '@/features/logist-kanban/engine/requests/repo';

// GET /api/logist-kanban/queues → QueuesResponse (справочник очередей для формы и фильтров — всем вошедшим)
// PUT /api/logist-kanban/queues  QueueUpsertBody → { queue }  (canManageLogistKanban)
export const dynamic = 'force-dynamic';

export async function GET() {
  return withActor('queues', async a => {
    const [queues, settings] = await Promise.all([loadQueues(), loadSettings()]);
    return NextResponse.json({ queues: a.canManage ? queues : queues.filter(q => q.active), settings, canManage: a.canManage } satisfies QueuesResponse, { headers: NO_STORE });
  }, { zone: false });
}

export async function PUT(req: NextRequest) {
  return withActor('queues:put', async a => {
    if (!a.canManage) return err('Настройки очередей — только руководителю логистики', 403, 'forbidden');
    const queue = await upsertQueue(parseQueueBody(await jsonBody(req)), a.login);
    return NextResponse.json({ queue }, { headers: NO_STORE });
  }, { zone: false });
}
