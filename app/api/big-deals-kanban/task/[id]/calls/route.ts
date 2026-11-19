import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listClientCalls } from '@/features/ai-analysis/engine/collect';
import { BigActionError } from '@/features/big-deals-kanban/engine/actions';
import { taskClientRef } from '@/features/big-deals-kanban/engine/taskClient';

// Вкладка «Звонки» карточки задачи: все звонки заказчика с текстами. Доступ — как к самой задаче
// (section.repeat_kanban + задача в зоне смотрящего), заказчик — из сделки задачи (engine/taskClient.ts).
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const ref = await taskClientRef(session, Number((await ctx.params).id));
    if (!ref) return NextResponse.json({ calls: [], noClient: true });
    return NextResponse.json({ calls: await listClientCalls(ref, true) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof BigActionError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error('[big-deals calls]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось загрузить звонки заказчика' }, { status: 500 });
  }
}
