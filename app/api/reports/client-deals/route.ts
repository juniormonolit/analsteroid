import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchClientMetricDeals, CLIENT_DRILL_METRIC_IDS } from '@/features/reports/engine/clientDrilldown';
import { CLIENT_FAMILY_METRIC_IDS, CLIENT_DRILL_FALLBACK_ID } from '@/features/reports/engine/clientDrilldownShared';
import type { DealFilter } from '@/lib/metrics/dealFilters';
import { getSessionScope, scopeDeptIdsBitrix, canSeeManager } from '@/lib/org/sessionScope';

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

  let dimension = (sp.get('dimension') ?? 'total') as 'manager' | 'product-group' | 'period' | 'total';
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

  // dimValues: НЕ '(…)?.split… || undefined' — пустой массив truthy, уезжал в опции
  // как dimValues=[] и глушил dimValue в движке (инцидент 03.09).
  let dimValue: string | undefined = sp.get('dimValue') ?? undefined;
  let dimValues: string[] | undefined = sp.get('dimValues') ? sp.get('dimValues')!.split(',').map(s => s.trim()).filter(Boolean) : undefined;
  let departmentIds: string[] = (sp.get('departmentIds') ?? '').split(',').filter(Boolean);

  // ── Срез сессии (аудит доступа 09.09): заказчики только менеджеров среза.
  // «Итого»/период для не-админа превращаются в список менеджеров среза, чужие
  // dimValue/dimValues отсекаются, отделы пересекаются со своими.
  const scope = await getSessionScope(session);
  if (scope.kind !== 'all') {
    const allowed = [...scope.managerIds];
    if (dimension === 'manager') {
      const req = dimValues?.length ? dimValues : (dimValue ? [dimValue] : []);
      const eff = req.length ? req.filter(id => canSeeManager(scope, id)) : allowed;
      if (eff.length === 0) return NextResponse.json({ error: 'Эти менеджеры вам недоступны' }, { status: 403 });
      dimValues = eff; dimValue = undefined;
    } else if (dimension === 'total' || dimension === 'period') {
      if (allowed.length === 0) return NextResponse.json({ error: 'Данные вам недоступны' }, { status: 403 });
      dimension = 'manager'; dimValues = allowed; dimValue = undefined;
    } else {
      if (scope.kind === 'self') return NextResponse.json({ error: 'Разрез по товарным группам доступен только руководителям и администраторам' }, { status: 403 });
      const eff = await scopeDeptIdsBitrix(scope, departmentIds.length ? departmentIds : undefined);
      if (eff !== null && eff.length === 0) return NextResponse.json({ error: 'Запрошенные отделы вне вашего доступа' }, { status: 403 });
      departmentIds = eff ?? [];
    }
  }

  const result = await fetchClientMetricDeals({
    metricId: effectiveId,
    period: { from: new Date(from), to: new Date(to) },
    dimension,
    dimValue,
    dimValues,
    productGroupMode: (sp.get('productGroupMode') as 'kc' | 'by_max' | null) ?? undefined,
    dealScope: (sp.get('scope') as 'primary' | 'repeat' | 'all' | null) ?? undefined,
    clientType: (sp.get('clientType') as 'all' | 'b2c' | 'b2b' | null) ?? undefined,
    departmentIds,
    dealFilters,
  });
  if (!result) return NextResponse.json({ error: 'метрика не поддержана' }, { status: 400 });
  // populationMetricId — по какому правилу реально построено население. Когда оно
  // не совпадает с metricId, сработал фолбэк «все отгрузки периода»: «Разбор
  // метрики» обязан это знать и не сверять такой итог с ячейкой (население иное).
  return NextResponse.json({ ...result, populationMetricId: effectiveId });
}
