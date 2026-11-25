import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, jsonBody, parseId, withActor } from '@/features/logist-kanban/engine/requests/http';
import { applyAction, loadDetails } from '@/features/logist-kanban/engine/requests/repo';
import { parseAction } from '@/features/logist-kanban/engine/requests/validate';
import { logLogist } from '@/lib/activity/services';

// GET   /api/logist-kanban/request/:id  → RequestDetails (отмечает чат прочитанным; ?peek=1 — не отмечать)
// PATCH /api/logist-kanban/request/:id  UpdateDraftBody → RequestDetails (= action update_draft)
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return withActor('request', async a => {
    const d = await loadDetails(a, parseId(id), { markRead: req.nextUrl.searchParams.get('peek') !== '1' });
    return NextResponse.json(d, { headers: NO_STORE });
  });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return withActor('request:patch', async (a, s) => {
    const b = (await jsonBody(req)) as Record<string, unknown>;
    const body = parseAction({ ...b, action: 'update_draft' });
    const out = await applyAction(a, parseId(id), body);
    void logLogist(s, 'update_draft', out.id, out.deal?.id ?? null);
    return NextResponse.json(out, { headers: NO_STORE });
  });
}
