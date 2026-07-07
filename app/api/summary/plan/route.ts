import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getCachedPlanSummary } from '@/lib/jobs/planSummary';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const summary = await getCachedPlanSummary();
  if (!summary) {
    return NextResponse.json({ error: 'Данные ещё не рассчитаны или устарели' }, { status: 503 });
  }
  return NextResponse.json(summary);
}
