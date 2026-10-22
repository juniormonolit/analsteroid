import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { managerSummary } from '@/features/ai-analysis/engine/summary';

// Сводка по менеджерам из отчётов ИИ-анализа — то же право, что у вкладки (все РОПы видят всё).
const PERIODS = new Set([30, 90, 365]);

export async function GET(req: NextRequest) {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'action.ai_call_analysis')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const days = Number(req.nextUrl.searchParams.get('days') ?? 90);
  try {
    return NextResponse.json(await managerSummary(PERIODS.has(days) ? days : 90));
  } catch (e) {
    console.error('[ai-analysis/summary]', e);
    return NextResponse.json({ error: 'Не удалось собрать сводку' }, { status: 500 });
  }
}
