import { NextRequest, NextResponse } from 'next/server';
import { subDays } from 'date-fns';
import { getSession } from '@/lib/auth/session';
import { resolveSummaryScope, parseBranchParam } from '@/lib/summary/scope';
import { applyPreset } from '@/lib/period';
import { fetchByManagers } from '@/features/reports/engine/byManagers';

export interface TopManagerRow {
  managerId: string;
  name: string;
  login: string | null;
  salesCount: number;
}

export interface SummaryTopManagersResponse {
  hasAccess: boolean;
  managers: TopManagerRow[];
  periodFrom: string;
  periodTo: string;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const branch = parseBranchParam(req.nextUrl.searchParams.get('branch'));
  const scope = await resolveSummaryScope(session, branch);

  const today = applyPreset('today');
  // «Последние 7 дней», капнуто по вчера (тот же принцип, что и общий период
  // приложения — decision владельца п.1) — 7 полных суток: today-7..today-1.
  const period = { from: subDays(today.from, 7), to: subDays(today.to, 1) };

  if (!scope.hasAccess) {
    const empty: SummaryTopManagersResponse = {
      hasAccess: false, managers: [],
      periodFrom: period.from.toISOString(), periodTo: period.to.toISOString(),
    };
    return NextResponse.json(empty);
  }

  const rows = await fetchByManagers({ period, dealScope: 'all', clientType: 'all', accountType: 'managers' });

  const managers: TopManagerRow[] = rows
    .filter(r => scope.managerIds.has(r.dimensionId))
    .map(r => ({
      managerId: r.dimensionId,
      name: r.dimensionName,
      login: r.dimensionSubtitle ?? null,
      salesCount: r.metrics.sales_count ?? 0,
    }))
    .filter(m => m.salesCount > 0)
    .sort((a, b) => b.salesCount - a.salesCount)
    .slice(0, 5);

  const body: SummaryTopManagersResponse = {
    hasAccess: true, managers,
    periodFrom: period.from.toISOString(), periodTo: period.to.toISOString(),
  };
  return NextResponse.json(body);
}
