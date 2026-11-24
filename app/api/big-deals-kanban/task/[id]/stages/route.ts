import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { bx } from '@/lib/bitrix/notify';
import { BigActionError } from '@/features/big-deals-kanban/engine/actions';
import { visibleTaskDealId } from '@/features/big-deals-kanban/engine/taskClient';
import { dealStageNames } from '@/features/big-deals-kanban/engine/enrich';
import { crmReadWebhook } from '@/features/big-deals-kanban/engine/rest';
import type { BigStageStep } from '@/features/big-deals-kanban/engine/types';

// История стадий сделки задачи (Осипов 24.11: «дату изменения этапа сделки, и при нажатии чтоб красиво открывалась
// история по стадиям с датами»). Битрикс crm.stagehistory.list — только чтение; доступ — как к самой задаче.
export const dynamic = 'force-dynamic';

interface Row { TYPE_ID: number | string; CREATED_TIME: string; STAGE_ID: string; STAGE_SEMANTIC_ID?: string }

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const dealId = await visibleTaskDealId(session, Number((await ctx.params).id));
    if (!dealId) return NextResponse.json({ steps: [] });
    const [r, names] = await Promise.all([
      bx(crmReadWebhook(), 'crm.stagehistory.list', {
        entityTypeId: 2, order: { CREATED_TIME: 'ASC' }, filter: { OWNER_ID: dealId },
        select: ['TYPE_ID', 'CREATED_TIME', 'STAGE_ID', 'STAGE_SEMANTIC_ID'],
      }) as Promise<{ result?: { items?: Row[] } }>,
      dealStageNames().catch(() => new Map<string, { name: string; color: string | null }>()),
    ]);
    const steps: BigStageStep[] = (r.result?.items ?? []).map(x => {
      const t = Number(x.TYPE_ID);
      return {
        at: new Date(x.CREATED_TIME).toISOString(), stageId: x.STAGE_ID,
        name: names.get(x.STAGE_ID)?.name ?? x.STAGE_ID, color: names.get(x.STAGE_ID)?.color ?? null,
        kind: t === 1 ? 'created' : t === 5 ? 'funnel' : 'moved',
        semantic: x.STAGE_SEMANTIC_ID === 'S' ? 'won' : x.STAGE_SEMANTIC_ID === 'F' ? 'lost' : null,
      };
    });
    return NextResponse.json({ steps }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof BigActionError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error('[big-deals stages]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Битрикс не отдал историю стадий' }, { status: 502 });
  }
}
