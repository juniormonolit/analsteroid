import { NextRequest, NextResponse } from 'next/server';
import { dismissalFail, dismissalGuard } from '@/features/dismissal/engine/http';
import { getRunDetail, runAction, startRun } from '@/features/dismissal/engine/store';
import { kickDismissalWorker } from '@/features/dismissal/engine/worker';

export const dynamic = 'force-dynamic';

const ACTIONS = ['start', 'pause', 'resume', 'cancel', 'retry', 'rescan'] as const;
type Action = typeof ACTIONS[number];

// start — draft → queued (валидирует план); pause | resume | cancel | retry | rescan — см. features/dismissal/types.ts.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string; action: string }> }) {
  const g = await dismissalGuard();
  if (g.error) return g.error;
  const { id, action } = await ctx.params;
  if (!(ACTIONS as readonly string[]).includes(action)) return NextResponse.json({ error: 'Неизвестное действие' }, { status: 404 });
  try {
    const a = action as Action;
    if (a === 'start') await startRun(id);
    else await runAction(id, a);
    console.log(`[dismissal] ${id}: ${a} — ${g.session.login}`);
    if (a !== 'pause' && a !== 'cancel') kickDismissalWorker();
    return NextResponse.json(await getRunDetail(id));
  } catch (e) {
    return dismissalFail(e, `run ${action}`);
  }
}
