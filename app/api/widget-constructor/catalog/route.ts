import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getCachedWidgetMetrics } from '@/lib/jobs/widgetMetrics';
import { buildCatalog } from '@/lib/widget/resolve';
import { WIDGET_METRICS } from '@/lib/widget/metrics';
import { WIDGET_PERIOD_PRESETS, WIDGET_PERIOD_LABELS } from '@/lib/widget/periods';

// Каталог для селектов конструктора: метрики, периоды, доступные разрезы (из блоба —
// scope_id гарантированно совпадёт с тем, что режет /custom).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const blob = await getCachedWidgetMetrics();
  const catalog = buildCatalog(blob);

  return NextResponse.json({
    metrics: WIDGET_METRICS,
    periods: WIDGET_PERIOD_PRESETS.map(k => ({ key: k, label: WIDGET_PERIOD_LABELS[k] })),
    scopes: catalog,
  });
}
