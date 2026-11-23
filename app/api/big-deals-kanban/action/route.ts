import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { bigActor } from '@/features/big-deals-kanban/engine/actor';
import { BigActionError, runBigAction } from '@/features/big-deals-kanban/engine/actions';
import { takeAttachments } from '@/features/repeat-kanban/engine/attachments';
import type { BigAction } from '@/features/big-deals-kanban/engine/types';

// Действия канбана больших чеков (engine/actions.ts). Гейт — section.repeat_kanban (те же роли продаж),
// зона — ropScope/scopeManagers, как у канбана повторных: РОП — свои отделы с поддеревом, менеджер — себя.
// move/reassign/accept/return/complete/participants/renew/deadline — только canManage; comment — любой, кто видит задачу.
// ?dry=1 — сухой прогон (только админу/полной зоне): ничего не пишет, отдаёт список REST-вызовов.
export const dynamic = 'force-dynamic';

const TYPES = new Set(['move', 'reassign', 'comment', 'accept', 'approve', 'return', 'complete', 'participants', 'renew', 'deadline']);

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await req.json().catch(() => null) as (BigAction & { attachments?: unknown }) | null;
  if (!body || typeof body.type !== 'string' || !TYPES.has(body.type)) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  try {
    const actor = { ...(await bigActor(session)), login: session.login };
    const dryRun = req.nextUrl.searchParams.get('dry') === '1';
    if (dryRun && actor.zone !== 'all') return NextResponse.json({ error: 'Сухой прогон — только админу' }, { status: 403 });
    const files = body.type === 'comment' || body.type === 'reassign' || body.type === 'return' || body.type === 'accept' ? takeAttachments(session.login, body.attachments) : [];
    const r = await runBigAction(body, actor, { dryRun }, files);
    console.info(`[big-deals action] ${session.login} ${body.type} task=${body.taskId}${dryRun ? ' DRY' : ''}${r.viaWebhook ? ' VIA-WEBHOOK' : ''} calls=${r.calls.map(c => c.method).join(',')}`);
    return NextResponse.json({ ok: true, card: r.card ?? undefined, warnings: r.warnings.length ? r.warnings : undefined, ...(dryRun ? { calls: r.calls } : {}) });
  } catch (e) {
    if (e instanceof BigActionError) {
      // Отказы тоже в лог: 23.11 «не ставится менеджер» — в логе не было ни попытки, ни причины.
      console.info(`[big-deals action] ${session.login} ${body.type} task=${body.taskId} ОТКАЗ ${e.status}: ${e.message}`);
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error('[big-deals action]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось выполнить действие — повторите или откройте задачу в Битриксе' }, { status: 500 });
  }
}
