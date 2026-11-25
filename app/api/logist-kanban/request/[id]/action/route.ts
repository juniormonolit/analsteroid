import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, jsonBody, parseId, withActor } from '@/features/logist-kanban/engine/requests/http';
import { applyAction } from '@/features/logist-kanban/engine/requests/repo';
import { parseAction } from '@/features/logist-kanban/engine/requests/validate';
import { logLogist } from '@/lib/activity/services';

// POST /api/logist-kanban/request/:id/action  ActionBody → ActionResponse (свежая карточка).
// Права и допустимость перехода — status.ts canDo(); 403 forbidden / 409 transition|conflict / 400 invalid.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withActor('action', async (a, s) => {
    const body = parseAction(await jsonBody(req));
    const out = await applyAction(a, parseId(id), body);
    void logLogist(s, body.action, out.id, out.deal?.id ?? null);
    return NextResponse.json(out, { headers: NO_STORE });
  });
}
