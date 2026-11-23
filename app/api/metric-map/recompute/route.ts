import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { recomputeMetricMaps } from '@/features/metric-map/engine/service';

// Кнопка «Пересчитать» «Карты показателей»: пересчитывает снимки незакрытых периодов
// и дефолтные срезы компании, закрытые снимки сбрасывает (пересчитаются при открытии).
// Ночью то же делает фоновая задача metricMapNightly (instrumentation.ts).
export async function POST() {
  const session = await getSession();
  const denied = permError(session, 'section.metric_map');
  if (denied) return denied;
  try {
    const r = await recomputeMetricMaps(true);
    console.log(`[metric-map] пересчёт по кнопке (${session!.displayName}): ${r.count} снимков`);
    return NextResponse.json({ ok: true, computedAt: r.computedAt });
  } catch (err) {
    console.error('[metric-map] пересчёт упал:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Пересчёт не удался' }, { status: 500 });
  }
}
