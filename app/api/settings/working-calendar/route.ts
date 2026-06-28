import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = systemDb();
  const res = await db.query<{ year: number }>(
    `SELECT DISTINCT EXTRACT(YEAR FROM date)::int AS year
     FROM working_calendar
     ORDER BY year`
  );

  return NextResponse.json({
    years: res.rows.map(r => r.year),
    total: res.rows.length,
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { year } = body as { year: number };

  if (!year || typeof year !== 'number') {
    return NextResponse.json({ error: 'year is required' }, { status: 400 });
  }

  const apiRes = await fetch(`https://isdayoff.ru/api/getdata?year=${year}`);
  if (!apiRes.ok) {
    return NextResponse.json({ error: 'Failed to fetch calendar data' }, { status: 502 });
  }
  const data = await apiRes.text();

  // Build date list: index 0 = Jan 1 of year
  const startDate = new Date(year, 0, 1);
  const rows: { date: string; isWorking: boolean }[] = [];
  for (let i = 0; i < data.length; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    if (d.getFullYear() !== year) break;
    const isWorking = data[i] === '0'; // '0' = working, '1' = non-working
    const dateStr = d.toISOString().slice(0, 10);
    rows.push({ date: dateStr, isWorking });
  }

  const db = systemDb();

  // Delete existing rows for this year
  await db.query(
    `DELETE FROM working_calendar WHERE EXTRACT(YEAR FROM date) = $1`,
    [year]
  );

  // Batch insert
  if (rows.length > 0) {
    const values = rows.map((r, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
    const params = rows.flatMap(r => [r.date, r.isWorking]);
    await db.query(
      `INSERT INTO working_calendar (date, is_working) VALUES ${values}`,
      params
    );
  }

  return NextResponse.json({ inserted: rows.length });
}
