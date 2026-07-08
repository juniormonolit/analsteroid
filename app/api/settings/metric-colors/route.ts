import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { ycAnalyticsDb } from '@/lib/db/clients';
import { invalidateMetricsCache } from '@/lib/metrics/catalog';
import { categoryDefaultColor } from '@/lib/metrics/entity-colors';

// Правила цветов метрик: категории + точечные переопределения по метрике.
// Ручные правила (metric_colors) — приоритет; когда правила нет, действует
// автоцвет по сущности (lib/metrics/entity-colors.ts, задача 6а, п.10 спеки
// 2026-07-08) — autoCategoryColors ниже отдаёт превью этого автоцвета для UI.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = ycAnalyticsDb();
  const [rules, cats] = await Promise.all([
    db.query<{ scope: string; key: string; color: string }>('SELECT scope, key, color FROM metric_colors ORDER BY scope, key'),
    db.query<{ category: string }>(`SELECT DISTINCT category FROM metrics WHERE category IS NOT NULL AND (is_active = true OR is_hidden_in_ui = false) ORDER BY 1`),
  ]);
  const categories = cats.rows.map(r => r.category);
  const autoCategoryColors = Object.fromEntries(
    categories.map(cat => [cat, categoryDefaultColor(cat)]),
  );
  return NextResponse.json({ rules: rules.rows, categories, autoCategoryColors });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

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
