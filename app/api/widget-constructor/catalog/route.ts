import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getCachedWidgetMetrics } from '@/lib/jobs/widgetMetrics';
import { buildCatalog } from '@/lib/widget/resolve';
import { WIDGET_METRICS } from '@/lib/widget/metrics';
import { WIDGET_PERIOD_PRESETS, WIDGET_PERIOD_LABELS } from '@/lib/widget/periods';
import { loadWidgetScopeAccess } from '@/lib/widget/scopeAccess';

// Каталог для селектов конструктора: метрики, периоды, доступные разрезы (из блоба —
// scope_id гарантированно совпадёт с тем, что режет /custom).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Аудит 09.09: каталог перечислял ВСЕ филиалы/отделы компании. Теперь — только
  // разрезы среза сессии (lib/widget/scopeAccess.ts): филиал — если покрыт целиком,
  // отдел — если входит в срез; «Россия» на клиенте остаётся кнопкой, но preview/
  // config/custom ответят 403 не-админу.
  const [blob, access] = await Promise.all([getCachedWidgetMetrics(), loadWidgetScopeAccess(session)]);
  const catalog = access.filterCatalog(buildCatalog(blob));

  return NextResponse.json({
    metrics: WIDGET_METRICS,
    periods: WIDGET_PERIOD_PRESETS.map(k => ({ key: k, label: WIDGET_PERIOD_LABELS[k] })),
    scopes: catalog,
  });
}
