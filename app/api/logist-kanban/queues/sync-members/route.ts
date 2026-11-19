import { NextResponse } from 'next/server';
import type { SyncMembersResponse } from '@/features/logist-kanban/engine/requests/contract';
import { NO_STORE, err, withActor } from '@/features/logist-kanban/engine/requests/http';
import { syncQueueMembersFromBitrix } from '@/features/logist-kanban/engine/requests/queues';

// POST /api/logist-kanban/queues/sync-members → SyncMembersResponse: кнопка «обновить состав» (canManageLogistKanban).
// Состав очереди = активные участники проекта Битрикса (решение владельца 19.11). Битрикс — только чтение.
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST() {
  return withActor('queues:sync-members', async a => {
    if (!a.canManage) return err('Обновить состав очередей может только руководитель логистики', 403, 'forbidden');
    const r: SyncMembersResponse = await syncQueueMembersFromBitrix(a.login);
    return NextResponse.json(r, { headers: NO_STORE });
  }, { zone: false });
}
