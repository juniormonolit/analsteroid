import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';

const SAFE_NAME = /^[a-zA-Z0-9_]+$/;

const DEFAULT_SORT: Record<string, { col: string; dir: 'ASC' | 'DESC' }> = {
  deals:       { col: 'deal_id',  dir: 'DESC' },
  deal_events: { col: 'event_at', dir: 'DESC' },
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { name } = await params;
  if (!SAFE_NAME.test(name)) {
    return NextResponse.json({ error: 'Invalid table name' }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const page  = Math.max(1, parseInt(searchParams.get('page')  ?? '1',  10));
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10)));
  const offset = (page - 1) * limit;

  const db = analyticsDb();

  // Get columns
  const colsRes = await db.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'sa' AND table_name = $1
     ORDER BY ordinal_position`,
    [name]
  );
  const columns = colsRes.rows.map(r => r.column_name);

  // Sort
  const rawSortBy  = searchParams.get('sortBy')  ?? '';
  const rawSortDir = searchParams.get('sortDir') ?? '';
  const def = DEFAULT_SORT[name];
  const sortCol = (rawSortBy && columns.includes(rawSortBy)) ? rawSortBy : def?.col ?? columns[0];
  const sortDir = rawSortDir === 'asc' ? 'ASC' : rawSortDir === 'desc' ? 'DESC' : (def?.dir ?? 'ASC');

  // Per-column filters → parameterized ILIKE on ::text cast
  const whereParts: string[] = [];
  const queryParams: unknown[] = [];

  for (const [key, val] of searchParams.entries()) {
    if (!key.startsWith('filter_') || !val.trim()) continue;
    const col = key.slice(7);
    if (!columns.includes(col)) continue;
    queryParams.push(`%${val.trim()}%`);
    whereParts.push(`"${col}"::text ILIKE $${queryParams.length}`);
  }

  const whereSQL = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  // Total count
  const totalRes = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM sa."${name}" AS t ${whereSQL}`,
    queryParams
  );
  const total = parseInt(totalRes.rows[0].count, 10);

  // Rows
  const rowsRes = await db.query(
    `SELECT t.*
     FROM sa."${name}" AS t
     ${whereSQL}
     ORDER BY "${sortCol}" ${sortDir}
     OFFSET $${queryParams.length + 1} LIMIT $${queryParams.length + 2}`,
    [...queryParams, offset, limit]
  );

  return NextResponse.json({ columns, rows: rowsRes.rows, total, sortCol, sortDir: sortDir.toLowerCase() });
}
