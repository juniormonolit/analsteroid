import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, jsonBody, parseId, withActor } from '@/features/logist-kanban/engine/requests/http';
import { listMessages, postMessage } from '@/features/logist-kanban/engine/requests/repo';
import { InputError, str } from '@/features/logist-kanban/engine/requests/validate';

// GET  /api/logist-kanban/request/:id/messages?after=<id> → MessagesResponse (поллинг чата + лента событий)
// POST /api/logist-kanban/request/:id/messages  PostMessageBody → PostMessageResponse
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return withActor('messages', async a => {
    const after = Number(req.nextUrl.searchParams.get('after') ?? 0);
    return NextResponse.json(await listMessages(a, parseId(id), Number.isInteger(after) && after > 0 ? after : 0), { headers: NO_STORE });
  }, { zone: true });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return withActor('messages:post', async a => {
    const b = (await jsonBody(req)) as Record<string, unknown>;
    const body = str(b.body, 8000);
    if (!body) throw new InputError('Пустое сообщение');
    const fileIds = Array.isArray(b.fileIds) ? b.fileIds.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 20) : [];
    return NextResponse.json(await postMessage(a, parseId(id), body, fileIds), { status: 201, headers: NO_STORE });
  });
}
