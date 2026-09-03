import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchClientMetricDeals, CLIENT_DRILL_METRIC_IDS } from '@/features/reports/engine/clientDrilldown';
import { CLIENT_FAMILY_METRIC_IDS, CLIENT_DRILL_FALLBACK_ID } from '@/features/reports/engine/clientDrilldownShared';
import type { DealFilter } from '@/lib/metrics/dealFilters';

// Дрилл-даун клиентских метрик — заказчики со свёрнутыми сделками (задача
// владельца 17.08). Гейт — как у /api/reports/deals: любой залогиненный
// (страницы отчётов сами закрыты правами разделов, второй рубеж — раскладка
// данных по строкам, которую этот роут и воспроизводит).
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const metricId = sp.get('metricId') ?? '';
  const from = sp.get('from');
  const to = sp.get('to');
  if (!from || !to || !metricId) {
    return NextResponse.json({ error: 'metricId, from, to обязательны' }, { status: 400 });
  }
  // Метрики без точного правила населения (медианы/доли/снимки) — фолбэк на
  // «все отгрузки клиентов периода»; '__row__' — клик по строке без метрики.
  const effectiveId = CLIENT_DRILL_METRIC_IDS.includes(metricId)
    ? metricId
    : (metricId === '__row__' || CLIENT_FAMILY_METRIC_IDS.includes(metricId))
      ? CLIENT_DRILL_FALLBACK_ID
      : null;
  if (!effectiveId) {
    return NextResponse.json({ error: `метрика ${metricId} не поддерживает клиентский дрилл` }, { status: 400 });
  }

  const dimension = (sp.get('dimension') ?? 'total') as 'manager' | 'product-group' | 'period' | 'total';
  if (!['manager', 'product-group', 'period', 'total'].includes(dimension)) {
    return NextResponse.json({ error: 'dimension: manager | product-group | period | total' }, { status: 400 });
  }

  let dealFilters: DealFilter[] = [];
  const dfRaw = sp.get('dealFilters');
  if (dfRaw) {
    try {
      const parsed = JSON.parse(dfRaw);
      if (Array.isArray(parsed)) dealFilters = parsed as DealFilter[];
    } catch { /* битый параметр — игнорируем, как в deals/route.ts */ }
  }

  const result = await fetchClientMetricDeals({
    metricId: effectiveId,
    period: { from: new Date(from), to: new Date(to) },
    dimension,
    dimValue: sp.get('dimValue') ?? undefined,
    // НЕ '(…)?.split… || undefined': пустой массив truthy, uезжал в опции как
    // dimValues=[] и глушил dimValue в движке ('??' видит не-null) — клиентский
    // дрилл по строке МЕНЕДЖЕРА всегда отвечал «Нет заказчиков» (инцидент 03.09).
    dimValues: sp.get('dimValues') ? sp.get('dimValues')!.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    productGroupMode: (sp.get('productGroupMode') as 'kc' | 'by_max' | null) ?? undefined,
    dealScope: (sp.get('scope') as 'primary' | 'repeat' | 'all' | null) ?? undefined,
    clientType: (sp.get('clientType') as 'all' | 'b2c' | 'b2b' | null) ?? undefined,
    departmentIds: (sp.get('departmentIds') ?? '').split(',').filter(Boolean),
    dealFilters,
  });
  if (!result) return NextResponse.json({ error: 'метрика не поддержана' }, { status: 400 });
  return NextResponse.json(result);
}
