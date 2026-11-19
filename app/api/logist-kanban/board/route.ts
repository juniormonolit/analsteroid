import { NextRequest, NextResponse } from 'next/server';
import { analyticsDb } from '@/lib/db/clients';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import type { BoardResponse, BoardView } from '@/features/logist-kanban/engine/requests/contract';
import { parseFilters } from '@/features/logist-kanban/engine/requests/filters';
import { NO_STORE, withActor } from '@/features/logist-kanban/engine/requests/http';
import { loadBoard } from '@/features/logist-kanban/engine/requests/repo';

// Канбан запросов логистам — доска. GET ?view=board|deals&<фильтры>&limit=N → BoardResponse (contract.ts).
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Отделы DepartmentPicker (bitrix id или uuid) → bitrix id менеджеров (как у канбана повторных). */
async function managersOfDepts(deptIds: string[]): Promise<string[]> {
  const numeric = deptIds.filter(x => /^\d+$/.test(x));
  const uuids = deptIds.filter(x => !/^\d+$/.test(x));
  if (numeric.length) {
    const r = await analyticsDb().query<{ id: string }>(`SELECT id::text AS id FROM sa.departments WHERE bitrix_department_id::text = ANY($1::text[])`, [numeric]);
    uuids.push(...r.rows.map(x => x.id));
  }
  const rows = await resolveManagersForDepartments(uuids);
  return [...new Set(rows.map(m => String(m.managerId)).filter(id => /^\d+$/.test(id)))];
}

export async function GET(req: NextRequest) {
  return withActor('board', async a => {
    const sp = req.nextUrl.searchParams;
    const view: BoardView = sp.get('view') === 'deals' ? 'deals' : 'board';
    const filters = parseFilters(sp);
    if (filters.managerDepts?.length) {
      const inDepts = await managersOfDepts(filters.managerDepts);
      filters.managers = filters.managers?.length ? filters.managers.filter(m => inDepts.includes(m)) : inDepts;
      if (!filters.managers.length) filters.managers = ['0']; // отделы без менеджеров → пусто, а не «все»
    }
    const limit = Number(sp.get('limit') ?? 100);
    const board: BoardResponse = await loadBoard(a, { view, filters, limit: Number.isFinite(limit) ? limit : 100 });
    return NextResponse.json(board, { headers: NO_STORE });
  });
}
