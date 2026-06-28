import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import type { MetricHighlightConfig } from '@/lib/saved-reports/types';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = systemDb();
  const res = await db.query<{ metric_id: string; config: MetricHighlightConfig }>(
    `SELECT metric_id, config FROM user_metric_highlights WHERE user_login = $1`,
    [session.login]
  );
  const map: Record<string, MetricHighlightConfig> = {};
  for (const row of res.rows) map[row.metric_id] = row.config;
  return NextResponse.json(map);
}
