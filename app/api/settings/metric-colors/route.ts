import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { ycAnalyticsDb } from '@/lib/db/clients';
import { invalidateMetricsCache } from '@/lib/metrics/catalog';

// Правила цветов метрик: категории + точечные переопределения по метрике.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = ycAnalyticsDb();
  const [rules, cats] = await Promise.all([
    db.query<{ scope: string; key: string; color: string }>('SELECT scope, key, color FROM metric_colors ORDER BY scope, key'),
    db.query<{ category: string }>(`SELECT DISTINCT category FROM metrics WHERE category IS NOT NULL AND (is_active = true OR is_hidden_in_ui = false) ORDER BY 1`),
  ]);
  return NextResponse.json({ rules: rules.rows, categories: cats.rows.map(r => r.category) });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ error: 'Только для администратора' }, { status: 403 });

  const body: { rules: { scope: string; key: string; color: string }[] } = await req.json();
  const rules = (body.rules ?? []).filter(r =>
    (r.scope === 'category' || r.scope === 'metric') &&
    typeof r.key === 'string' && r.key.length > 0 &&
    /^#[0-9a-fA-F]{6}$/.test(r.color)
  );

  const db = ycAnalyticsDb();
  await db.query('DELETE FROM metric_colors');
  for (const r of rules) {
    await db.query('INSERT INTO metric_colors (scope, key, color) VALUES ($1, $2, $3) ON CONFLICT (scope, key) DO UPDATE SET color = EXCLUDED.color', [r.scope, r.key, r.color]);
  }
  invalidateMetricsCache(); // цвета резолвятся в loadMetrics
  return NextResponse.json({ ok: true, saved: rules.length });
}
