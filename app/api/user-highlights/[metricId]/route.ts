import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import type { MetricHighlightConfig } from '@/lib/saved-reports/types';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ metricId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { metricId } = await params;
  const db = systemDb();
  const res = await db.query<{ config: MetricHighlightConfig }>(
    `SELECT config FROM user_metric_highlights WHERE user_login = $1 AND metric_id = $2`,
    [session.login, metricId]
  );
  return NextResponse.json(res.rows[0]?.config ?? null);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ metricId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { metricId } = await params;
  const config: MetricHighlightConfig | null = await req.json();
  const db = systemDb();

  if (!config) {
    await db.query(
      `DELETE FROM user_metric_highlights WHERE user_login = $1 AND metric_id = $2`,
      [session.login, metricId]
    );
  } else {
    await db.query(
      `INSERT INTO user_metric_highlights (user_login, metric_id, config, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_login, metric_id) DO UPDATE SET config = $3, updated_at = NOW()`,
      [session.login, metricId, JSON.stringify(config)]
    );
  }
  return NextResponse.json({ ok: true });
}
