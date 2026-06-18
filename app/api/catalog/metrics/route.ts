import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadMetrics } from '@/lib/metrics/catalog';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const metrics = await loadMetrics();
  return NextResponse.json({ metrics: metrics.filter(m => !m.isHiddenInUi) });
}
