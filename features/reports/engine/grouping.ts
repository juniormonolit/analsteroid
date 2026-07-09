import type { Grouping, Metric, ReportRow } from '@/lib/metrics/types';
import { computeTotals } from './calculated';
import { branchLabel } from '@/lib/org/branchLabel';

export interface GroupedRow extends ReportRow {
  isGroup?: boolean;
  children?: ReportRow[];
}

export function applyGrouping(rows: ReportRow[], grouping: Grouping, allMetrics: Metric[]): GroupedRow[] {
  if (grouping === 'none') return rows;

  if (grouping === 'total') {
    const totals = computeTotals(rows, allMetrics);
    return [{
      dimensionId: '__total__',
      dimensionName: 'Итого',
      teamId: null,
      teamName: null,
      metrics: totals,
      isGroup: true,
    }];
  }

  if (grouping === 'branch') {
    const groups = new Map<string, ReportRow[]>();
    for (const row of rows) {
      const key = row.branchName ?? 'СПб'; // правило: не Москва и не Краснодар → СПб
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }
    const result: GroupedRow[] = [];
    for (const [branch, members] of groups) {
      result.push({
        dimensionId: `__branch__${branch}`,
        // Display-слой (п.5 правок 09.07/2): «СПб»→«Санкт-Петербург» и т.п. — ключ
        // dimensionId/branchName остаётся сырым (маршрутизация дрилл-дауна/фильтры).
        dimensionName: branchLabel(branch),
        teamId: null,
        teamName: null,
        branchName: branch,
        metrics: computeTotals(members, allMetrics),
        isGroup: true,
        children: members,
      });
    }
    return result;
  }

  // grouping === 'team'
  const groups = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const key = row.teamId ?? '__no_team__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const result: GroupedRow[] = [];
  for (const [teamId, members] of groups) {
    const totals = computeTotals(members, allMetrics);
    const teamName = members[0]?.teamName ?? 'Без отдела';
    result.push({
      dimensionId: `__team__${teamId}`,
      dimensionName: teamName,
      teamId,
      teamName,
      metrics: totals,
      isGroup: true,
      children: members,
    });
  }
  return result;
}
