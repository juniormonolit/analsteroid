import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getCachedPlanSummary } from '@/lib/jobs/planSummary';

function tokenValid(provided: string | null): boolean {
  const expected = process.env.WIDGET_API_TOKEN;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!tokenValid(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = await getCachedPlanSummary();
  if (!summary) {
    return NextResponse.json({ error: 'Данные ещё не рассчитаны или устарели' }, { status: 503 });
  }
  return NextResponse.json(summary);
}
