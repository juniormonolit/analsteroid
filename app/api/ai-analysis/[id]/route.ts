import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { getAnalysis, saveFeedback } from '@/features/ai-analysis/engine/store';

// Статус/отчёт одного анализа (поллинг вкладки) и отзыв «полезно / неточно».
async function guard() {
  const session = await getSession().catch(() => null);
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!hasPerm(session, 'action.ai_call_analysis')) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { session };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g.error) return g.error;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const row = await getAnalysis(id);
  if (!row) return NextResponse.json({ error: 'Анализ не найден' }, { status: 404 });
  return NextResponse.json(row);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g.error) return g.error;
  const id = Number((await ctx.params).id);
  const body = await req.json().catch(() => ({})) as { feedback?: string; note?: string };
  if (!Number.isInteger(id) || (body.feedback !== 'useful' && body.feedback !== 'inaccurate')) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  await saveFeedback(id, { feedback: body.feedback, note: body.note?.trim().slice(0, 2000) || null, by: g.session.login });
  return NextResponse.json({ ok: true });
}
