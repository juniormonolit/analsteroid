import { NextResponse } from 'next/server';
import { NO_STORE, parseId, withActor } from '@/features/logist-kanban/engine/requests/http';
import { loadDetails } from '@/features/logist-kanban/engine/requests/repo';
import { drainRequest } from '@/features/logist-kanban/engine/bitrix/sync';

// S4 — POST /api/logist-kanban/request/:id/bx-sync → { done, error } — повторить запись в дубль-задачу сейчас,
// не дожидаясь бэкоффа (кнопка «повторить» у bx_sync_status='error' в карточке). Кто видит запрос.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withActor('bx-sync', async a => {
    const requestId = parseId(id);
    await loadDetails(a, requestId, { markRead: false }); // проверка видимости
    return NextResponse.json(await drainRequest(requestId, { force: true }), { headers: NO_STORE });
  });
}
