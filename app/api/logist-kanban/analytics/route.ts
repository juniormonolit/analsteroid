import { NextRequest, NextResponse } from 'next/server';
import type { AnalyticsResponse } from '@/features/logist-kanban/engine/requests/contract';
import { parseFilters } from '@/features/logist-kanban/engine/requests/filters';
import { NO_STORE, withActor } from '@/features/logist-kanban/engine/requests/http';
import { loadAnalytics } from '@/features/logist-kanban/engine/requests/my';
import { expandManagerDepts } from '@/features/logist-kanban/engine/requests/managerDepts';

// Аналитика руководителей (S5): плитки за период + разрез регион → департамент → очередь → логист.
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&<фильтры доски> → AnalyticsResponse. РОП — своя зона (ropScope), руководитель
// логистики / админ — всё; остальным 403.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return withActor('analytics', async a => {
    const filters = parseFilters(req.nextUrl.searchParams);
    await expandManagerDepts(filters);
    const res: AnalyticsResponse = await loadAnalytics(a, filters);
    return NextResponse.json(res, { headers: NO_STORE });
  });
}
